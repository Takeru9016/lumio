import { Prisma } from "@/generated/prisma/client";
import type { CourseStatus, LearningPathStatus } from "@/generated/prisma/enums";
import type { AuthContext } from "@/lib/auth/context";
import { db } from "@/lib/db";
import { isValidId } from "@/lib/domain/learning-assignment/inputRules";
import {
  type CourseFacts,
  courseBlockReason,
  isCourseAvailable,
} from "@/lib/domain/learning-path/availability";
import {
  assertPathManager,
  buildNewPath,
  parseAddCourseInput,
  parseReorderInput,
  parseUpdatePathInput,
} from "@/lib/domain/learning-path/inputRules";
import { assertPathEditable } from "@/lib/domain/learning-path/lifecycle";
import { encodeCursor, parseListQuery } from "@/lib/domain/learning-path/listing";
import { assertCourseMayJoin, assertCourseMayLeave } from "@/lib/domain/learning-path/membership";
import {
  nextPosition,
  type PathMember,
  planReorder,
  positionsAfterRemoval,
  sortMembers,
} from "@/lib/domain/learning-path/ordering";
import { fail, type PublishBlockReason } from "@/lib/domain/learning-path/types";

/**
 * Learning path operations for an organisation's administrators (Phase 29.3.1).
 *
 * Every function takes the authenticated context and derives the tenant and the
 * acting admin from it; nothing in a request can name either. Every write to a
 * path or its courses runs in one transaction that first takes the path's row lock
 * (`lockPath`): that lock is the serialization point, and everything that depends
 * on mutable path state (its status, its members, how many there are) is read
 * AFTER it, so a concurrent add, remove, reorder or status change is seen in full
 * or not at all.
 *
 * Nothing here reads or writes anything but paths, their memberships, and the
 * courses and lessons it looks at: a path is an ordered recommendation, and the
 * membership rules themselves live in the pure helpers this module only calls.
 */

type Client = Prisma.TransactionClient;

const SUMMARY_SELECT = {
  id: true,
  title: true,
  description: true,
  status: true,
  publishedAt: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { courses: true } },
} satisfies Prisma.LearningPathSelect;

export type AdminPathSummary = {
  id: string;
  title: string;
  description: string | null;
  status: LearningPathStatus;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  courseCount: number;
};

export type AdminPathCourse = {
  courseId: string;
  slug: string;
  title: string;
  position: number;
  courseStatus: CourseStatus;
  /** Whether a learner can take the course to completion right now. */
  availability: "AVAILABLE" | "UNAVAILABLE";
  /** Why it could not be in a published path, or null when nothing blocks it. */
  blockReason: PublishBlockReason | null;
};

export type AdminPathDetail = Omit<AdminPathSummary, "courseCount"> & {
  courses: AdminPathCourse[];
};

export type AdminPathList = {
  paths: AdminPathSummary[];
  /** True when more paths match beyond this page. */
  hasMore: boolean;
  /** Pass back as `cursor` for the next (older) page; null on the last page. */
  nextCursor: string | null;
};

type SummaryRow = Prisma.LearningPathGetPayload<{ select: typeof SUMMARY_SELECT }>;

function toSummary(row: SummaryRow): AdminPathSummary {
  const { _count, ...path } = row;
  return { ...path, courseCount: _count.courses };
}

/** A malformed id cannot name a path, so it is the same NOT_FOUND as one that does not exist. */
function pathIdOrNotFound(pathId: unknown): string {
  if (!isValidId(pathId)) throw fail.notFound();
  return pathId;
}

type LockedPath = { id: string; status: LearningPathStatus };

/**
 * Takes the path's row lock and returns its status as it stands now. Only a path
 * of `tenantId` can be found, so another tenant's path and one that does not exist
 * are the same NOT_FOUND. Row locks are released at commit or rollback, and a
 * transaction waiting here reads the committed row once it gets the lock.
 */
async function lockPath(tx: Client, pathId: string, tenantId: string): Promise<LockedPath> {
  const rows = await tx.$queryRaw<LockedPath[]>`
    SELECT id, status FROM "LearningPath"
    WHERE id = ${pathId} AND "tenantId" = ${tenantId}
    FOR UPDATE`;
  const path = rows[0];
  if (!path) throw fail.notFound();
  return path;
}

/** The courses (of `courseIds`) that have a published, non-archived lesson: the completion test. */
async function coursesWithPublishedLessons(
  client: Client | typeof db,
  courseIds: string[]
): Promise<Set<string>> {
  if (courseIds.length === 0) return new Set();
  const sections = await client.section.findMany({
    where: {
      courseId: { in: courseIds },
      lessons: { some: { isPublished: true, isArchived: false } },
    },
    select: { courseId: true },
  });
  return new Set(sections.map((s) => s.courseId));
}

type MemberRow = {
  courseId: string;
  position: number;
  course: {
    id: string;
    slug: string;
    title: string;
    tenantId: string | null;
    status: CourseStatus;
  };
};

async function loadMembers(client: Client | typeof db, pathId: string): Promise<MemberRow[]> {
  return client.learningPathCourse.findMany({
    where: { pathId },
    select: {
      courseId: true,
      position: true,
      course: { select: { id: true, slug: true, title: true, tenantId: true, status: true } },
    },
  });
}

const factsOf = (course: MemberRow["course"], withLessons: Set<string>): CourseFacts => ({
  id: course.id,
  title: course.title,
  tenantId: course.tenantId,
  status: course.status,
  hasPublishedLesson: withLessons.has(course.id),
});

/**
 * The whole admin view of one path in a bounded number of queries (the path, its
 * members with their courses, and one lesson lookup), however many courses it
 * holds. Courses are shown as they are now: a course archived since it was added
 * is reported as such, and the path is not changed to match.
 */
async function loadDetail(
  client: Client | typeof db,
  pathId: string,
  tenantId: string
): Promise<AdminPathDetail> {
  const path = await client.learningPath.findFirst({
    where: { id: pathId, tenantId },
    select: SUMMARY_SELECT,
  });
  if (!path) throw fail.notFound();

  const members = await loadMembers(client, path.id);
  const withLessons = await coursesWithPublishedLessons(
    client,
    members.map((m) => m.courseId)
  );

  const { _count, ...summary } = path;
  const courses = sortMembers(members).map((member): AdminPathCourse => {
    const facts = factsOf(member.course, withLessons);
    return {
      courseId: member.courseId,
      slug: member.course.slug,
      title: member.course.title,
      position: member.position,
      courseStatus: member.course.status,
      availability: isCourseAvailable(facts) ? "AVAILABLE" : "UNAVAILABLE",
      blockReason: courseBlockReason(facts, tenantId),
    };
  });
  return { ...summary, courses };
}

/**
 * Writes `plan` as the members' positions in one statement. There is no unique
 * index on (pathId, position), so the write can never trip over itself; and being a
 * single statement, the path never shows a half-applied order.
 */
async function writePositions(tx: Client, pathId: string, plan: PathMember[]): Promise<void> {
  if (plan.length === 0) return;
  await tx.$executeRaw`
    UPDATE "LearningPathCourse" AS m
    SET "position" = v.position
    FROM (
      SELECT unnest(${plan.map((p) => p.courseId)}::text[]) AS "courseId",
             unnest(${plan.map((p) => p.position)}::int[]) AS position
    ) AS v
    WHERE m."pathId" = ${pathId} AND m."courseId" = v."courseId"`;
}

/** Membership changes are changes to the path, so its `updatedAt` moves with them. */
async function touch(tx: Client, pathId: string): Promise<void> {
  await tx.learningPath.update({ where: { id: pathId }, data: { updatedAt: new Date() } });
}

/** Creates a DRAFT path, empty, owned by the caller's tenant and created by the caller. */
export async function createLearningPath(
  ctx: AuthContext,
  input: unknown
): Promise<AdminPathSummary> {
  const data = buildNewPath(ctx, input);
  const created = await db.learningPath.create({ data, select: SUMMARY_SELECT });
  return toSummary(created);
}

/**
 * Changes a path's title and/or description, whatever else it holds. A DRAFT or
 * PUBLISHED path can be edited; an ARCHIVED one is PATH_ARCHIVED, and this never
 * changes its status. A published path stays publishable: the title rule here is
 * the publishability rule, and metadata does not touch membership.
 */
export async function updateLearningPath(
  ctx: AuthContext,
  pathId: unknown,
  input: unknown
): Promise<AdminPathSummary> {
  const actor = assertPathManager(ctx);
  const id = pathIdOrNotFound(pathId);
  const update = parseUpdatePathInput(input);

  return db.$transaction(async (tx) => {
    const path = await lockPath(tx, id, actor.tenantId);
    assertPathEditable(path.status);
    const updated = await tx.learningPath.update({
      where: { id: path.id },
      data: update,
      select: SUMMARY_SELECT,
    });
    return toSummary(updated);
  });
}

/** One path of the caller's tenant, whatever its status, with its courses in path order. */
export async function getLearningPathForAdmin(
  ctx: AuthContext,
  pathId: unknown
): Promise<AdminPathDetail> {
  const actor = assertPathManager(ctx);
  return loadDetail(db, pathIdOrNotFound(pathId), actor.tenantId);
}

/**
 * One page of the caller's tenant's paths, newest first, every status unless a
 * filter names one. The tenant and the filter are applied in the query before the
 * page is cut, and each path's course count comes from the same query, so the cost
 * does not grow with the number of courses or paths on the page.
 */
export async function listLearningPathsForAdmin(
  ctx: AuthContext,
  raw: { status?: unknown; cursor?: unknown; limit?: unknown } = {}
): Promise<AdminPathList> {
  const actor = assertPathManager(ctx);
  const { status, cursor, limit } = parseListQuery(raw);

  const rows = await db.learningPath.findMany({
    where: {
      tenantId: actor.tenantId,
      ...(status ? { status } : {}),
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: SUMMARY_SELECT,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    paths: page.map(toSummary),
    hasMore,
    nextCursor: hasMore && last ? encodeCursor(last) : null,
  };
}

/**
 * The unique index on (pathId, courseId) is the last guard against a duplicate: the
 * membership check under the lock answers the ordinary case, and if a duplicate
 * ever got past it the database still refuses it, as DUPLICATE and not a 500.
 */
function translateAddError(err: unknown): unknown {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") return fail.duplicate();
    if (err.code === "P2003") return fail.courseNotFound();
  }
  return err;
}

/**
 * Adds a course at the end of the path. The course's tenant, status and lessons
 * are read after the lock and judged by `assertCourseMayJoin` alone: the eligibility
 * rules are not restated here. The position is max + 1 and is never the client's.
 */
export async function addCourseToLearningPath(
  ctx: AuthContext,
  pathId: unknown,
  input: unknown
): Promise<AdminPathDetail> {
  const actor = assertPathManager(ctx);
  const id = pathIdOrNotFound(pathId);
  const { courseId } = parseAddCourseInput(input);

  try {
    return await db.$transaction(async (tx) => {
      const path = await lockPath(tx, id, actor.tenantId);
      const members = await tx.learningPathCourse.findMany({
        where: { pathId: path.id },
        select: { courseId: true, position: true },
      });

      const course = await tx.course.findUnique({
        where: { id: courseId },
        select: { id: true, slug: true, title: true, tenantId: true, status: true },
      });
      const withLessons = course
        ? await coursesWithPublishedLessons(tx, [course.id])
        : new Set<string>();

      assertCourseMayJoin({
        path: {
          tenantId: actor.tenantId,
          status: path.status,
          members: members.map((m) => ({ id: m.courseId })),
        },
        course: course ? factsOf(course, withLessons) : null,
      });

      await tx.learningPathCourse.create({
        data: {
          pathId: path.id,
          courseId,
          position: nextPosition(members.map((m) => m.position)),
        },
      });
      await touch(tx, path.id);
      return loadDetail(tx, path.id, actor.tenantId);
    });
  } catch (err) {
    throw translateAddError(err);
  }
}

/**
 * Removes a course and closes the gap: the remaining members are renumbered 1..n in
 * the same transaction. Whether it may go is `assertCourseMayLeave`'s decision, made
 * on the members as they are under the lock. A course that is not a member (or
 * whose id is malformed) is COURSE_NOT_FOUND, whether or not it exists elsewhere.
 */
export async function removeCourseFromLearningPath(
  ctx: AuthContext,
  pathId: unknown,
  courseId: unknown
): Promise<AdminPathDetail> {
  const actor = assertPathManager(ctx);
  const id = pathIdOrNotFound(pathId);
  if (!isValidId(courseId)) throw fail.courseNotFound();

  return db.$transaction(async (tx) => {
    const path = await lockPath(tx, id, actor.tenantId);
    const members = await loadMembers(tx, path.id);
    const withLessons = await coursesWithPublishedLessons(
      tx,
      members.map((m) => m.courseId)
    );

    assertCourseMayLeave({
      path: {
        tenantId: actor.tenantId,
        status: path.status,
        members: members.map((m) => factsOf(m.course, withLessons)),
      },
      courseId,
    });

    await tx.learningPathCourse.deleteMany({ where: { pathId: path.id, courseId } });
    await writePositions(tx, path.id, positionsAfterRemoval(members, courseId));
    await touch(tx, path.id);
    return loadDetail(tx, path.id, actor.tenantId);
  });
}

/**
 * Puts the path's courses in the order the client names them. The request must be
 * the complete set of the path's courses as they are under the lock: a course
 * missing, extra or unknown is STALE_ORDER, a malformed list is INVALID_INPUT. It
 * only ever renumbers: no membership is created or deleted, and an ARCHIVED path
 * is PATH_ARCHIVED.
 */
export async function reorderLearningPath(
  ctx: AuthContext,
  pathId: unknown,
  input: unknown
): Promise<AdminPathDetail> {
  const actor = assertPathManager(ctx);
  const id = pathIdOrNotFound(pathId);
  const { courseIds } = parseReorderInput(input);

  return db.$transaction(async (tx) => {
    const path = await lockPath(tx, id, actor.tenantId);
    assertPathEditable(path.status);

    const members = await tx.learningPathCourse.findMany({
      where: { pathId: path.id },
      select: { courseId: true },
    });
    const plan = planReorder(
      members.map((m) => m.courseId),
      courseIds
    );

    await writePositions(tx, path.id, plan);
    await touch(tx, path.id);
    return loadDetail(tx, path.id, actor.tenantId);
  });
}
