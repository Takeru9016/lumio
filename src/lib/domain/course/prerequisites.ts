import { type CourseStatus, Prisma } from "@/generated/prisma/client";
import type { AuthContext } from "@/lib/auth/context";
import { db } from "@/lib/db";
import { isValidId } from "@/lib/domain/learning-assignment/inputRules";

/**
 * Course prerequisites (Phase 29.1): "course B requires course A".
 *
 * A prerequisite is a hard, course-to-course rule with AND semantics: a learner
 * satisfies it by holding a COMPLETED Enrollment on the prerequisite course.
 * Nothing about a learner is stored here. Both courses must belong to the same,
 * non-null tenant, an edge may never close a cycle, and a course has at most
 * MAX_PREREQUISITES_PER_COURSE prerequisites.
 *
 * This module only defines and reads the rule. It is deliberately not wired into
 * enrollment, ordering or assignment yet (Phase 29.2 does that with
 * `getUnmetPrerequisites`).
 */

export const MAX_PREREQUISITES_PER_COURSE = 5;

export type CoursePrerequisiteErrorCode =
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "SELF_REFERENCE"
  | "COURSE_ARCHIVED"
  | "DUPLICATE"
  | "CYCLE"
  | "LIMIT_REACHED";

/** Prose never names an id, a tenant or a database message. */
export class CoursePrerequisiteError extends Error {
  constructor(
    public status: 400 | 403 | 404 | 409,
    public code: CoursePrerequisiteErrorCode,
    message: string
  ) {
    super(message);
    this.name = "CoursePrerequisiteError";
  }
}

const fail = {
  forbidden: () => new CoursePrerequisiteError(403, "FORBIDDEN", "Forbidden"),
  courseNotFound: () => new CoursePrerequisiteError(404, "NOT_FOUND", "Course not found"),
  prerequisiteNotFound: () =>
    new CoursePrerequisiteError(404, "NOT_FOUND", "Prerequisite not found"),
  invalid: () =>
    new CoursePrerequisiteError(
      400,
      "INVALID_INPUT",
      "courseId and prerequisiteCourseId are required"
    ),
  self: () =>
    new CoursePrerequisiteError(409, "SELF_REFERENCE", "A course can't be its own prerequisite"),
  archived: () =>
    new CoursePrerequisiteError(
      409,
      "COURSE_ARCHIVED",
      "Archived courses can't be added to prerequisites"
    ),
  duplicate: () =>
    new CoursePrerequisiteError(409, "DUPLICATE", "That course is already a prerequisite"),
  cycle: () =>
    new CoursePrerequisiteError(409, "CYCLE", "That would make the prerequisites circular"),
  limit: () =>
    new CoursePrerequisiteError(
      409,
      "LIMIT_REACHED",
      `A course can have at most ${MAX_PREREQUISITES_PER_COURSE} prerequisites`
    ),
};

/** `db` or an interactive-transaction client. */
type Client = Prisma.TransactionClient;

type ManagedCourse = { id: string; tenantId: string; status: CourseStatus };

/**
 * The single authorization boundary for every mutation and authoring read in
 * this module, following courseSkillManagement.ts:
 *
 * - ORG_ADMIN: the tenant is folded into the WHERE clause, so another tenant's
 *   course simply does not match.
 * - INSTRUCTOR: must own the course. A course that is missing, tenantless or in
 *   another tenant is one uniform 404, so a foreign course id cannot be probed
 *   for; a same-tenant course owned by someone else is the established 403.
 * - Anyone else (STUDENT, SUPER_ADMIN) is refused, and that is decided before
 *   any client-supplied id is looked at.
 *
 * A tenantless course can never take part, so it is never returned.
 */
function assertMayManage(ctx: AuthContext): void {
  if (ctx.role !== "ORG_ADMIN" && ctx.role !== "INSTRUCTOR") throw fail.forbidden();
}

async function resolveManagedCourse(ctx: AuthContext, courseId: unknown): Promise<ManagedCourse> {
  assertMayManage(ctx);
  if (!isValidId(courseId)) throw fail.invalid();
  if (!ctx.tenantId) throw fail.courseNotFound();

  if (ctx.role === "ORG_ADMIN") {
    const course = await db.course.findFirst({
      where: { id: courseId, tenantId: ctx.tenantId },
      select: { id: true, tenantId: true, status: true },
    });
    if (!course?.tenantId) throw fail.courseNotFound();
    return { id: course.id, tenantId: course.tenantId, status: course.status };
  }

  const course = await db.course.findUnique({
    where: { id: courseId },
    select: { id: true, tenantId: true, status: true, instructorId: true },
  });
  if (!course || course.tenantId === null || course.tenantId !== ctx.tenantId) {
    throw fail.courseNotFound();
  }
  if (course.instructorId !== ctx.userId) throw fail.forbidden();
  return { id: course.id, tenantId: course.tenantId, status: course.status };
}

/**
 * The tenant's row lock is the serialization boundary for every prerequisite
 * write. The graph reads, the duplicate and cycle checks, the count and the
 * insert or delete all happen while holding it, so two writers can never each
 * see a graph that lacks the other's edge. Locking only the two courses would
 * not be enough: in A>B>C>D>A the two closing edges share no course.
 */
async function lockTenant(tx: Client, tenantId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR UPDATE`;
}

type Edge = { courseId: string; prerequisiteCourseId: string };

/**
 * Would adding `edge` (courseId requires prerequisiteCourseId) close a cycle?
 * Following prerequisites from the new prerequisite must not lead back to the
 * course that would require it. Pure, and iterative so a long chain cannot
 * overflow the stack.
 */
export function wouldCloseCycle(existing: readonly Edge[], edge: Edge): boolean {
  if (edge.courseId === edge.prerequisiteCourseId) return true;

  const requires = new Map<string, string[]>();
  for (const e of existing) {
    const list = requires.get(e.courseId);
    if (list) list.push(e.prerequisiteCourseId);
    else requires.set(e.courseId, [e.prerequisiteCourseId]);
  }

  const seen = new Set<string>([edge.prerequisiteCourseId]);
  const stack = [edge.prerequisiteCourseId];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const next of requires.get(current) ?? []) {
      if (next === edge.courseId) return true;
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return false;
}

export type AddCoursePrerequisiteInput = {
  courseId: string;
  prerequisiteCourseId: string;
};

export type CoursePrerequisiteEdge = {
  id: string;
  courseId: string;
  prerequisiteCourseId: string;
  createdAt: Date;
};

/**
 * Adds "courseId requires prerequisiteCourseId".
 *
 * Only `courseId` and `prerequisiteCourseId` are read. The tenant is the
 * dependent course's own, and the creator is the authenticated actor: neither
 * can be supplied. Nothing outside the actor's tenant can be attached, and
 * archived courses cannot be newly attached (an existing edge is never removed
 * because a course is archived; see `enforceable`).
 */
export async function addCoursePrerequisite(
  ctx: AuthContext,
  input: AddCoursePrerequisiteInput
): Promise<CoursePrerequisiteEdge> {
  // Role first, then the shape of both ids, then anything is looked up.
  assertMayManage(ctx);
  if (!isValidId(input?.courseId) || !isValidId(input.prerequisiteCourseId)) throw fail.invalid();
  const prerequisiteCourseId = input.prerequisiteCourseId;

  const course = await resolveManagedCourse(ctx, input.courseId);
  if (prerequisiteCourseId === course.id) throw fail.self();

  // Same tenant as the dependent course, which is itself never null. A foreign,
  // tenantless and unknown course are the same 404.
  const prerequisite = await db.course.findFirst({
    where: { id: prerequisiteCourseId, tenantId: course.tenantId },
    select: { id: true, status: true },
  });
  if (!prerequisite) throw fail.courseNotFound();
  if (course.status === "ARCHIVED" || prerequisite.status === "ARCHIVED") throw fail.archived();

  const edge = { courseId: course.id, prerequisiteCourseId: prerequisite.id };

  try {
    return await db.$transaction(async (tx) => {
      await lockTenant(tx, course.tenantId);

      // One query for the whole tenant's graph: courses only ever have edges to
      // courses of their own tenant, so this is every edge that could matter.
      const graph = await tx.coursePrerequisite.findMany({
        where: { course: { tenantId: course.tenantId } },
        select: { courseId: true, prerequisiteCourseId: true },
      });

      if (
        graph.some(
          (e) =>
            e.courseId === edge.courseId && e.prerequisiteCourseId === edge.prerequisiteCourseId
        )
      ) {
        throw fail.duplicate();
      }
      if (wouldCloseCycle(graph, edge)) throw fail.cycle();
      if (
        graph.filter((e) => e.courseId === edge.courseId).length >= MAX_PREREQUISITES_PER_COURSE
      ) {
        throw fail.limit();
      }

      return tx.coursePrerequisite.create({
        data: { ...edge, createdById: ctx.userId },
        select: { id: true, courseId: true, prerequisiteCourseId: true, createdAt: true },
      });
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      // The unique index is the real guarantee against a duplicate; the check
      // above only gives the common case a clean answer.
      if (err.code === "P2002") throw fail.duplicate();
      if (err.code === "P2003") throw fail.courseNotFound();
    }
    throw err;
  }
}

/**
 * Removes "courseId requires prerequisiteCourseId". Allowed whatever state
 * either course is in. Only an edge of the actor's own tenant can match.
 */
export async function removeCoursePrerequisite(
  ctx: AuthContext,
  input: AddCoursePrerequisiteInput
): Promise<void> {
  assertMayManage(ctx);
  if (!isValidId(input?.courseId) || !isValidId(input.prerequisiteCourseId)) throw fail.invalid();

  const course = await resolveManagedCourse(ctx, input.courseId);

  const removed = await db.$transaction(async (tx) => {
    await lockTenant(tx, course.tenantId);
    return tx.coursePrerequisite.deleteMany({
      where: {
        courseId: course.id,
        prerequisiteCourseId: input.prerequisiteCourseId,
        course: { tenantId: course.tenantId },
      },
    });
  });
  if (removed.count === 0) throw fail.prerequisiteNotFound();
}

export type PrerequisiteCourse = {
  prerequisiteCourseId: string;
  slug: string;
  title: string;
  status: CourseStatus;
  /** At least one published, non-archived lesson: the same test the completion route applies. */
  hasPublishedLessons: boolean;
  enforceable: boolean;
};

/**
 * Whether a prerequisite still binds a learner who has not completed it. A
 * course a learner cannot reach (anything but PUBLISHED, so ARCHIVED and DRAFT)
 * or one with no published, non-archived lesson can never be completed, so
 * requiring it would strand them. It is then a "retired" prerequisite: not
 * enforced, but kept, and a learner who completed it is still satisfied.
 *
 * This is not a waiver (that word is reserved for a future per-learner
 * override): it is a property of the prerequisite course, the same for everyone.
 */
export function isEnforceablePrerequisite(course: {
  status: CourseStatus;
  hasPublishedLessons: boolean;
}): boolean {
  return course.status === "PUBLISHED" && course.hasPublishedLessons;
}

/**
 * A course's prerequisites with what is needed to judge them, in a fixed number
 * of queries however many there are: the edges with their courses, then one
 * query for which of those courses have a published, non-archived lesson.
 * Edges to a course of another tenant cannot be created and are ignored if one
 * ever exists.
 */
async function loadPrerequisiteCourses(
  client: Client,
  courseId: string,
  tenantId: string
): Promise<PrerequisiteCourse[]> {
  const edges = await client.coursePrerequisite.findMany({
    where: { courseId, prerequisiteCourse: { tenantId } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      prerequisiteCourseId: true,
      prerequisiteCourse: { select: { slug: true, title: true, status: true } },
    },
  });
  if (edges.length === 0) return [];

  const withLessons = await client.section.findMany({
    where: {
      courseId: { in: edges.map((e) => e.prerequisiteCourseId) },
      lessons: { some: { isPublished: true, isArchived: false } },
    },
    select: { courseId: true },
  });
  const available = new Set(withLessons.map((s) => s.courseId));

  return edges.map((e) => {
    const hasPublishedLessons = available.has(e.prerequisiteCourseId);
    return {
      prerequisiteCourseId: e.prerequisiteCourseId,
      slug: e.prerequisiteCourse.slug,
      title: e.prerequisiteCourse.title,
      status: e.prerequisiteCourse.status,
      hasPublishedLessons,
      enforceable: isEnforceablePrerequisite({
        status: e.prerequisiteCourse.status,
        hasPublishedLessons,
      }),
    };
  });
}

/** The prerequisites of a course, for the people who manage it (authoring read). */
export async function listCoursePrerequisites(
  ctx: AuthContext,
  courseId: string
): Promise<PrerequisiteCourse[]> {
  const course = await resolveManagedCourse(ctx, courseId);
  return loadPrerequisiteCourses(db, course.id, course.tenantId);
}

export type UnmetPrerequisite = { slug: string; title: string };

/**
 * The enforceable prerequisites of `courseId` that `userId` has not completed.
 * A prerequisite is satisfied exactly when the learner's Enrollment on it is
 * COMPLETED (ACTIVE, REFUNDED and no enrollment are all unmet); a retired
 * prerequisite never appears here, and one the learner completed stays satisfied
 * whatever has happened to the course since.
 *
 * Read-only, and it takes `db` or a transaction so the enrollment paths of
 * Phase 29.2 can call it inside their own. A learner with no tenant, or a course
 * outside the learner's tenant, has no prerequisites to enforce, because
 * prerequisites exist only between courses of one tenant. It returns only what a
 * learner may be told (slug and title), never ids. A fixed five queries.
 */
export async function getUnmetPrerequisites(
  client: Client,
  params: { userId: string; courseId: string }
): Promise<UnmetPrerequisite[]> {
  const { userId, courseId } = params;
  if (!isValidId(userId) || !isValidId(courseId)) return [];

  const user = await client.user.findUnique({ where: { id: userId }, select: { tenantId: true } });
  if (!user?.tenantId) return [];

  const course = await client.course.findFirst({
    where: { id: courseId, tenantId: user.tenantId },
    select: { id: true },
  });
  if (!course) return [];

  const enforceable = (await loadPrerequisiteCourses(client, course.id, user.tenantId)).filter(
    (p) => p.enforceable
  );
  if (enforceable.length === 0) return [];

  const completed = await client.enrollment.findMany({
    where: {
      userId,
      courseId: { in: enforceable.map((p) => p.prerequisiteCourseId) },
      status: "COMPLETED",
    },
    select: { courseId: true },
  });
  const done = new Set(completed.map((e) => e.courseId));

  return enforceable
    .filter((p) => !done.has(p.prerequisiteCourseId))
    .map((p) => ({ slug: p.slug, title: p.title }));
}
