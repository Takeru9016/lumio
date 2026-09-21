import { type EnrollmentStatus, Prisma, type SkillProficiency } from "@/generated/prisma/client";
import type { AssignmentSource } from "@/generated/prisma/enums";
import type { AuthContext } from "@/lib/auth/context";
import { db } from "@/lib/db";
import { PROFICIENCY_ORDER } from "@/lib/domain/capability/proficiencyOrder";
import { authorizeActor } from "@/lib/domain/learning-assignment/assignments";
import {
  type AssignmentStatus,
  deriveAssignmentStatus,
} from "@/lib/domain/learning-assignment/status";

/** How many assignments one page of the admin list holds by default. */
export const ADMIN_PAGE_SIZE = 50;
/** The most one page may hold, however many are asked for. */
export const ADMIN_PAGE_MAX = 200;
/** The most learners / courses offered in the assign form's selectors. */
export const OPTIONS_LIMIT = 500;

/**
 * Why an assignment exists, as an administrator reads it. This is a projection
 * of the stored provenance snapshot, never the snapshot itself: it carries names
 * and levels but none of the ids (assigner, team, role, skill, policy, course)
 * the snapshot also holds. A malformed snapshot degrades to fewer details, never
 * to an error.
 */
export type AdminReason =
  | { kind: "MANUAL"; assignedByName: string | null; note: string | null }
  | { kind: "MANDATORY"; teamName: string | null }
  | {
      kind: "CAPABILITY_GAP";
      roleName: string | null;
      skillName: string | null;
      requiredProficiency: SkillProficiency | null;
      currentProficiency: SkillProficiency | null;
    }
  | { kind: "UNKNOWN" };

export type AdminAssignment = {
  id: string;
  learner: { name: string | null; email: string };
  course: { title: string; slug: string };
  source: AssignmentSource;
  reason: AdminReason;
  status: AssignmentStatus;
  dueDate: Date | null;
  createdAt: Date;
  /** Present exactly while the assignment is cancelled (the current state). */
  cancellation: { at: Date; byName: string | null } | null;
  /**
   * Present when the assignment has been cancelled at some point and is active
   * again: the most recent cancellation and how many there have been. Absent
   * for one that was never cancelled and for one that is cancelled right now
   * (that is `cancellation`).
   */
  previousCancellation: { at: Date; byName: string | null; count: number } | null;
};

export type AdminAssignmentFilters = {
  source?: AssignmentSource;
  status?: AssignmentStatus;
};

export type AdminAssignmentList = {
  assignments: AdminAssignment[];
  /** True when more assignments match the filters beyond this page. */
  hasMore: boolean;
  /** Pass back as `cursor` for the next (older) page; null on the last page. */
  nextCursor: string | null;
};

export class AssignmentCursorError extends Error {
  constructor() {
    super("Invalid cursor");
    this.name = "AssignmentCursorError";
  }
}

// The list is ordered newest first by (createdAt, id), both immutable, so a
// keyset cursor is stable however the rows' statuses change between pages.
type Cursor = { createdAt: Date; id: string };

function encodeCursor(row: Cursor): string {
  return Buffer.from(
    JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id }),
    "utf8"
  ).toString("base64");
}

/** Throws AssignmentCursorError for anything that is not a cursor this module issued. */
export function decodeCursor(raw: string): Cursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    if (
      !isRecord(parsed) ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.id !== "string"
    ) {
      throw new Error("malformed cursor payload");
    }
    const createdAt = new Date(parsed.createdAt);
    if (
      Number.isNaN(createdAt.getTime()) ||
      createdAt.toISOString() !== parsed.createdAt ||
      parsed.id.length === 0 ||
      parsed.id.length > 64
    ) {
      throw new Error("malformed cursor payload");
    }
    return { createdAt, id: parsed.id };
  } catch {
    throw new AssignmentCursorError();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function proficiency(value: unknown): SkillProficiency | null {
  return PROFICIENCY_ORDER.includes(value as SkillProficiency) ? (value as SkillProficiency) : null;
}

function projectAdminReason(source: AssignmentSource, raw: unknown): AdminReason {
  const reason = isRecord(raw) ? raw : {};
  if (source === "MANUAL") {
    return {
      kind: "MANUAL",
      assignedByName: text(reason.assignedByName),
      note: text(reason.note),
    };
  }
  if (source === "MANDATORY") return { kind: "MANDATORY", teamName: text(reason.teamName) };
  if (source === "CAPABILITY_GAP") {
    return {
      kind: "CAPABILITY_GAP",
      roleName: text(reason.roleName),
      skillName: text(reason.skillName),
      requiredProficiency: proficiency(reason.requiredProficiency),
      currentProficiency: proficiency(reason.currentProficiency),
    };
  }
  return { kind: "UNKNOWN" };
}

// Facts are keyed by learner AND course: unlike the learner read (one learner,
// so course alone is enough) this list spans many learners, and two of them on
// the same course must never be given each other's enrollment or progress.
const pairKey = (userId: string, courseId: string) => `${userId}:${courseId}`;

// A timestamp is sent as an ISO string and cast in SQL: a Date parameter would
// be serialized in the server's local zone, and these columns hold UTC.
const timestamp = (date: Date) => Prisma.sql`CAST(${date.toISOString()} AS timestamp)`;

/**
 * The SQL twin of `deriveAssignmentStatus`, for the statuses that are derived
 * from more than the assignment row. It exists so a status filter is applied
 * BEFORE the page is cut (a page must never be a window of the newest rows
 * with the filter applied afterwards). It restates the same first-match-wins
 * rules, so `adminAssignments.test.ts` checks it against the derivation
 * row by row, including the due-date boundary; change both together.
 *
 *   cancelled                  -> CANCELLED
 *   enrollment completed       -> COMPLETED
 *   due date strictly before now -> OVERDUE
 *   any lesson progress        -> STARTED
 *   otherwise                  -> ASSIGNED
 */
function statusPredicate(status: AssignmentStatus, now: Date): Prisma.Sql {
  const cancelled = Prisma.sql`(a."cancelledAt" IS NOT NULL)`;
  const completed = Prisma.sql`EXISTS (
    SELECT 1 FROM "Enrollment" e
    WHERE e."userId" = a."userId" AND e."courseId" = a."courseId" AND e."status" = 'COMPLETED')`;
  const overdue = Prisma.sql`(a."dueDate" IS NOT NULL AND a."dueDate" < ${timestamp(now)})`;
  const started = Prisma.sql`EXISTS (
    SELECT 1 FROM "LessonProgress" lp
    JOIN "Lesson" l ON l."id" = lp."lessonId"
    JOIN "Section" s ON s."id" = l."sectionId"
    WHERE lp."userId" = a."userId" AND s."courseId" = a."courseId")`;

  switch (status) {
    case "CANCELLED":
      return cancelled;
    case "COMPLETED":
      return Prisma.sql`NOT ${cancelled} AND ${completed}`;
    case "OVERDUE":
      return Prisma.sql`NOT ${cancelled} AND NOT ${completed} AND ${overdue}`;
    case "STARTED":
      return Prisma.sql`NOT ${cancelled} AND NOT ${completed} AND NOT ${overdue} AND ${started}`;
    case "ASSIGNED":
      return Prisma.sql`NOT ${cancelled} AND NOT ${completed} AND NOT ${overdue} AND NOT ${started}`;
  }
}

/**
 * The positions (id and creation time) of one page plus one, to learn whether
 * another page exists, with the tenant, the source and the status all applied in
 * the database before the page is cut. The tenant is a parameter here, never
 * part of a caller's filter.
 */
async function selectPageIds(
  tenantId: string,
  filters: AdminAssignmentFilters,
  cursor: Cursor | null,
  take: number,
  now: Date
): Promise<Cursor[]> {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`a."tenantId" = ${tenantId}`,
    Prisma.sql`u."deletedAt" IS NULL`,
  ];
  if (filters.source)
    conditions.push(Prisma.sql`a."source" = ${filters.source}::"AssignmentSource"`);
  if (filters.status) conditions.push(statusPredicate(filters.status, now));
  if (cursor) {
    conditions.push(
      Prisma.sql`(a."createdAt", a."id") < (${timestamp(cursor.createdAt)}, ${cursor.id})`
    );
  }

  const rows = await db.$queryRaw<Cursor[]>(Prisma.sql`
    SELECT a."id", a."createdAt"
    FROM "LearningAssignment" a
    JOIN "User" u ON u."id" = a."userId"
    WHERE ${Prisma.join(conditions, " AND ")}
    ORDER BY a."createdAt" DESC, a."id" DESC
    LIMIT ${take}`);
  return rows;
}

/**
 * One page of the organisation's learning assignments, newest first, cancelled
 * ones included (the learner read excludes them; an administrator needs to see
 * them).
 *
 * ORG_ADMIN only, and the tenant is always the session's. The source and status
 * filters are applied in the database before the page is cut, so a page of an
 * "Overdue" list is a page of the tenant's overdue assignments, and `hasMore` /
 * `nextCursor` describe that filtered list, not the newest rows. Status is never
 * stored: the rows shown are given their status by the same
 * `deriveAssignmentStatus` the learner sees, from bounded queries over the page.
 * (The two reads are not one snapshot: a row whose status changes between them
 * is listed under the filter it matched, and shows the status it has now.)
 *
 * A malformed `cursor` throws AssignmentCursorError.
 */
export async function listOrgAssignments(
  ctx: AuthContext,
  filters: AdminAssignmentFilters = {},
  options: { now?: Date; limit?: number; cursor?: string } = {}
): Promise<AdminAssignmentList> {
  authorizeActor(ctx);

  const now = options.now ?? new Date();
  const limit = Math.min(Math.max(1, options.limit ?? ADMIN_PAGE_SIZE), ADMIN_PAGE_MAX);
  const cursor = options.cursor === undefined ? null : decodeCursor(options.cursor);

  const positions = await selectPageIds(ctx.tenantId, filters, cursor, limit + 1, now);
  const hasMore = positions.length > limit;
  const page = hasMore ? positions.slice(0, limit) : positions;
  if (page.length === 0) return { assignments: [], hasMore: false, nextCursor: null };
  const pageIds = page.map((p) => p.id);

  const loaded = await db.learningAssignment.findMany({
    where: { id: { in: pageIds }, tenantId: ctx.tenantId, user: { deletedAt: null } },
    select: {
      id: true,
      userId: true,
      courseId: true,
      source: true,
      reason: true,
      dueDate: true,
      createdAt: true,
      cancelledAt: true,
      lastCancelledAt: true,
      lastCancelledByName: true,
      cancellationCount: true,
      user: { select: { name: true, email: true } },
      course: { select: { title: true, slug: true } },
    },
  });
  const position = new Map(pageIds.map((id, i) => [id, i]));
  const window = loaded.sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));

  const userIds = [...new Set(window.map((r) => r.userId))];
  const courseIds = [...new Set(window.map((r) => r.courseId))];

  const [enrollments, progress] = await Promise.all([
    db.enrollment.findMany({
      where: { userId: { in: userIds }, courseId: { in: courseIds } },
      select: { userId: true, courseId: true, status: true },
    }),
    db.$queryRaw<{ userId: string; courseId: string }[]>`
      SELECT DISTINCT lp."userId", s."courseId"
      FROM "LessonProgress" lp
      JOIN "Lesson" l ON l."id" = lp."lessonId"
      JOIN "Section" s ON s."id" = l."sectionId"
      WHERE lp."userId" = ANY(${userIds}) AND s."courseId" = ANY(${courseIds})`,
  ]);

  const enrollmentStatus = new Map<string, EnrollmentStatus>(
    enrollments.map((e) => [pairKey(e.userId, e.courseId), e.status])
  );
  const started = new Set(progress.map((p) => pairKey(p.userId, p.courseId)));

  const assignments = window.map((row): AdminAssignment => {
    const key = pairKey(row.userId, row.courseId);
    const cancelled = row.cancelledAt !== null;
    return {
      id: row.id,
      learner: { name: row.user.name, email: row.user.email },
      course: { title: row.course.title, slug: row.course.slug },
      source: row.source,
      reason: projectAdminReason(row.source, row.reason),
      status: deriveAssignmentStatus({
        cancelledAt: row.cancelledAt,
        dueDate: row.dueDate,
        enrollmentStatus: enrollmentStatus.get(key) ?? null,
        hasLessonProgress: started.has(key),
        now,
      }),
      dueDate: row.dueDate,
      createdAt: row.createdAt,
      cancellation: row.cancelledAt
        ? { at: row.cancelledAt, byName: row.lastCancelledByName }
        : null,
      previousCancellation:
        !cancelled && row.lastCancelledAt !== null && row.cancellationCount > 0
          ? {
              at: row.lastCancelledAt,
              byName: row.lastCancelledByName,
              count: row.cancellationCount,
            }
          : null,
    };
  });

  // The cursor is the last position the page query selected, not the last row
  // that happened to load: a row that vanished between the two reads (a learner
  // removed meanwhile) must never make the next page skip the rows after it.
  const last = page[page.length - 1];
  return { assignments, hasMore, nextCursor: hasMore ? encodeCursor(last) : null };
}

export type AssignmentOptions = {
  learners: { id: string; name: string | null; email: string }[];
  courses: { id: string; title: string; isCatalogue: boolean }[];
};

/**
 * What the assign form offers. This is a convenience list, not a rule: it shows
 * the courses an administrator can normally assign (their own tenant's and the
 * open catalogue's, published and free) and the active learners of their own
 * tenant. `createManualAssignment` remains the only authority on eligibility
 * and re-checks everything, so a stale or tampered selection is refused there.
 */
export async function listAssignmentOptions(ctx: AuthContext): Promise<AssignmentOptions> {
  authorizeActor(ctx);

  const assignable = { status: "PUBLISHED", price: 0 } as const;
  const [learners, own, catalogue] = await Promise.all([
    db.user.findMany({
      where: { tenantId: ctx.tenantId, role: "STUDENT", deletedAt: null },
      select: { id: true, name: true, email: true },
      orderBy: [{ name: "asc" }, { email: "asc" }],
      take: OPTIONS_LIMIT,
    }),
    // Queried separately, each with its own cap, so a large open catalogue can
    // never push the organisation's own courses out of the list.
    db.course.findMany({
      where: { ...assignable, tenantId: ctx.tenantId },
      select: { id: true, title: true },
      orderBy: { title: "asc" },
      take: OPTIONS_LIMIT,
    }),
    db.course.findMany({
      where: { ...assignable, tenantId: null },
      select: { id: true, title: true },
      orderBy: { title: "asc" },
      take: OPTIONS_LIMIT,
    }),
  ]);

  return {
    learners,
    courses: [
      ...own.map((c) => ({ id: c.id, title: c.title, isCatalogue: false })),
      ...catalogue.map((c) => ({ id: c.id, title: c.title, isCatalogue: true })),
    ],
  };
}
