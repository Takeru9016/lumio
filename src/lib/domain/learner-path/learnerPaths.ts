import type { LearningPathStatus } from "@/generated/prisma/enums";
import { type AuthContext, requireRole, requireTenant } from "@/lib/auth/context";
import { db } from "@/lib/db";
import { getPrerequisiteStandings } from "@/lib/domain/course/prerequisites";
import {
  deriveLearnerCourse,
  type LearnerPathCourse,
  type LearnerPathProgress,
  summarizeProgress,
} from "@/lib/domain/learner-path/availability";
import { isValidId } from "@/lib/domain/learning-assignment/inputRules";
import { encodeCursor, parseListQuery } from "@/lib/domain/learning-path/listing";
import { sortMembers } from "@/lib/domain/learning-path/ordering";
import { fail } from "@/lib/domain/learning-path/types";

/**
 * What a learner sees of their organisation's learning paths (Phase 29.3.3).
 *
 * Strictly read-only: nothing in this module writes, and the source is scanned by
 * a test to keep it so. A path is visible to a learner only when it is PUBLISHED and
 * belongs to the learner's own tenant, and anything else (another tenant's, a draft,
 * an archived one, an unknown or malformed id) is the same NOT_FOUND. The learner and
 * the tenant come from the session; nothing in a request can name them.
 *
 * Progress is derived from the learner's own course Enrollments and the courses as
 * they are now. There is no path enrollment, no path progress and no path
 * completion, and nothing is emitted when every course is completed.
 */

export function authorizeLearner(
  ctx: AuthContext
): asserts ctx is AuthContext & { tenantId: string } {
  requireRole(ctx, ["STUDENT"]);
  requireTenant(ctx);
}

/** The identity must still be a live STUDENT of that tenant, not merely a session that resolved. */
async function assertActiveLearner(ctx: AuthContext & { tenantId: string }): Promise<void> {
  const learner = await db.user.findFirst({
    where: { id: ctx.userId, tenantId: ctx.tenantId, role: "STUDENT", deletedAt: null },
    select: { id: true },
  });
  if (!learner) throw fail.forbidden();
}

export type LearnerPathSummary = {
  id: string;
  title: string;
  description: string | null;
  status: LearningPathStatus;
  publishedAt: Date | null;
  courseCount: number;
  progress: LearnerPathProgress;
};

export type LearnerPathDetail = Omit<LearnerPathSummary, "courseCount"> & {
  courses: LearnerPathCourse[];
};

export type LearnerPathList = {
  paths: LearnerPathSummary[];
  hasMore: boolean;
  nextCursor: string | null;
};

type MemberRow = {
  pathId: string;
  courseId: string;
  position: number;
  course: {
    slug: string;
    title: string;
    tenantId: string | null;
    status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  };
};

/**
 * The courses of `members` as this learner sees them, keyed by path, in a fixed
 * number of queries however many paths and courses there are: which of the courses
 * have a published lesson (1), which the learner has completed (1), and where they
 * stand on prerequisites (3).
 */
async function deriveCourses(
  ctx: AuthContext & { tenantId: string },
  members: MemberRow[]
): Promise<Map<string, LearnerPathCourse[]>> {
  const byPath = new Map<string, LearnerPathCourse[]>();
  if (members.length === 0) return byPath;

  const courseIds = [...new Set(members.map((m) => m.courseId))];
  const [sections, completions, standings] = await Promise.all([
    db.section.findMany({
      where: {
        courseId: { in: courseIds },
        lessons: { some: { isPublished: true, isArchived: false } },
      },
      select: { courseId: true },
    }),
    db.enrollment.findMany({
      where: { userId: ctx.userId, courseId: { in: courseIds }, status: "COMPLETED" },
      select: { courseId: true },
    }),
    getPrerequisiteStandings(db, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      courseIds,
    }),
  ]);
  const withLessons = new Set(sections.map((s) => s.courseId));
  const completed = new Set(completions.map((e) => e.courseId));

  for (const member of sortMembers(members)) {
    const entry = deriveLearnerCourse(ctx.tenantId, {
      courseId: member.courseId,
      slug: member.course.slug,
      title: member.course.title,
      position: member.position,
      tenantId: member.course.tenantId,
      status: member.course.status,
      hasPublishedLesson: withLessons.has(member.courseId),
      completed: completed.has(member.courseId),
      standing: standings.get(member.courseId) ?? "NONE",
    });
    const list = byPath.get(member.pathId) ?? [];
    list.push(entry);
    byPath.set(member.pathId, list);
  }
  return byPath;
}

const MEMBER_SELECT = {
  pathId: true,
  courseId: true,
  position: true,
  course: { select: { slug: true, title: true, tenantId: true, status: true } },
} as const;

/**
 * One page of the learner's tenant's PUBLISHED paths, newest first, each with its
 * course count and the learner's derived progress.
 *
 * The page is one query. Progress needs the members of the paths on that page, and
 * those are read for the whole page at once (one query, then one query each for
 * lessons, completions and prerequisite standings, three in all): eight queries for
 * a page, not one set per path. The most a page holds is bounded, so the members are
 * too. The tenant and the PUBLISHED filter are in the query, so a cursor cannot lead
 * to another tenant's or an unpublished path.
 */
export async function listLearningPathsForLearner(
  ctx: AuthContext,
  raw: { cursor?: unknown; limit?: unknown } = {}
): Promise<LearnerPathList> {
  authorizeLearner(ctx);
  await assertActiveLearner(ctx);
  const { cursor, limit } = parseListQuery({ cursor: raw.cursor, limit: raw.limit });

  const rows = await db.learningPath.findMany({
    where: {
      tenantId: ctx.tenantId,
      status: "PUBLISHED",
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
    select: {
      id: true,
      title: true,
      description: true,
      status: true,
      publishedAt: true,
      createdAt: true,
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const members =
    page.length === 0
      ? []
      : await db.learningPathCourse.findMany({
          where: { pathId: { in: page.map((p) => p.id) } },
          select: MEMBER_SELECT,
        });
  const courses = await deriveCourses(ctx, members);

  const last = page[page.length - 1];
  return {
    paths: page.map((path) => {
      const own = courses.get(path.id) ?? [];
      return {
        id: path.id,
        title: path.title,
        description: path.description,
        status: path.status,
        publishedAt: path.publishedAt,
        courseCount: own.length,
        progress: summarizeProgress(own),
      };
    }),
    hasMore,
    nextCursor: hasMore && last ? encodeCursor(last) : null,
  };
}

/**
 * One PUBLISHED path of the learner's tenant, with every course in path order and
 * the learner's derived progress. Anything else is NOT_FOUND, and indistinguishable:
 * another tenant's path, a draft, an archived path, an unknown id and a malformed id.
 *
 * A fixed number of queries however many courses the path has: the path (1), its
 * members with their courses (1), lessons (1), completions (1) and prerequisite
 * standings (3), plus the identity check.
 */
export async function getLearningPathForLearner(
  ctx: AuthContext,
  pathId: unknown
): Promise<LearnerPathDetail> {
  authorizeLearner(ctx);
  await assertActiveLearner(ctx);
  if (!isValidId(pathId)) throw fail.notFound();

  const path = await db.learningPath.findFirst({
    where: { id: pathId, tenantId: ctx.tenantId, status: "PUBLISHED" },
    select: { id: true, title: true, description: true, status: true, publishedAt: true },
  });
  if (!path) throw fail.notFound();

  const members = await db.learningPathCourse.findMany({
    where: { pathId: path.id },
    select: MEMBER_SELECT,
  });
  const courses = (await deriveCourses(ctx, members)).get(path.id) ?? [];

  return {
    id: path.id,
    title: path.title,
    description: path.description,
    status: path.status,
    publishedAt: path.publishedAt,
    courses,
    progress: summarizeProgress(courses),
  };
}

const LIST_PARAMS = ["limit", "cursor"] as const;

/**
 * The list's query string: only `limit` and `cursor`, each at most once. Anything
 * else, including an attempt to name a user or a tenant, is INVALID_INPUT rather
 * than silently ignored.
 */
export function readLearnerListQuery(params: URLSearchParams): { limit?: string; cursor?: string } {
  const query: { limit?: string; cursor?: string } = {};
  for (const key of new Set(params.keys())) {
    if (!(LIST_PARAMS as readonly string[]).includes(key)) throw fail.invalid("Unknown parameter");
    const values = params.getAll(key);
    if (values.length > 1) throw fail.invalid("Repeated parameter");
    query[key as "limit" | "cursor"] = values[0];
  }
  return query;
}
