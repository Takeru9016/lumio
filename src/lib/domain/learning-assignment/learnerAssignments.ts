import type { EnrollmentStatus, SkillProficiency } from "@/generated/prisma/client";
import type { AssignmentSource } from "@/generated/prisma/enums";
import { type AuthContext, requireRole, requireTenant } from "@/lib/auth/context";
import { db } from "@/lib/db";
import { PROFICIENCY_ORDER } from "@/lib/domain/capability/proficiencyOrder";
import {
  type AssignmentStatus,
  deriveAssignmentStatus,
} from "@/lib/domain/learning-assignment/status";

/**
 * What a learner is shown about why they were assigned a course. This is a
 * projection of the stored provenance snapshot, not the snapshot itself: the
 * snapshot also holds the assigner's id, the policy and team ids and the role
 * and skill ids, none of which are the learner's to see. Names and
 * proficiencies are kept because they are the answer to "why did I get this?".
 */
export type ManualLearnerReason = { assignedByName: string | null; note?: string };
export type MandatoryLearnerReason = { teamName: string };
export type CapabilityGapLearnerReason = {
  roleName: string;
  skillName: string;
  requiredProficiency: SkillProficiency;
  currentProficiency: SkillProficiency;
};

type LearnerAssignmentBase = {
  id: string;
  courseId: string;
  courseTitle: string;
  courseSlug: string;
  dueDate: Date | null;
  status: AssignmentStatus;
  createdAt: Date;
};

export type LearnerAssignment = LearnerAssignmentBase &
  (
    | { source: "MANUAL"; reason: ManualLearnerReason | null }
    | { source: "MANDATORY"; reason: MandatoryLearnerReason | null }
    | { source: "CAPABILITY_GAP"; reason: CapabilityGapLearnerReason | null }
  );

type AssignmentRow = {
  id: string;
  courseId: string;
  source: AssignmentSource;
  reason: unknown;
  dueDate: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  course: { title: string; slug: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProficiency(value: unknown): value is SkillProficiency {
  return PROFICIENCY_ORDER.includes(value as SkillProficiency);
}

/**
 * Reads the snapshot defensively: it is JSON in the database, so a row with an
 * unexpected shape yields no reason rather than an exception that would take
 * the learner's whole list down.
 */
function projectReason(source: AssignmentSource, reason: unknown) {
  if (!isRecord(reason)) return null;

  if (source === "MANUAL") {
    const name = reason.assignedByName;
    if (name !== null && typeof name !== "string") return null;
    if (!("assignedByName" in reason)) return null;
    return {
      assignedByName: name,
      ...(typeof reason.note === "string" && reason.note.length > 0 ? { note: reason.note } : {}),
    } satisfies ManualLearnerReason;
  }

  if (source === "MANDATORY") {
    return typeof reason.teamName === "string"
      ? ({ teamName: reason.teamName } satisfies MandatoryLearnerReason)
      : null;
  }

  if (
    typeof reason.roleName === "string" &&
    typeof reason.skillName === "string" &&
    isProficiency(reason.requiredProficiency) &&
    isProficiency(reason.currentProficiency)
  ) {
    return {
      roleName: reason.roleName,
      skillName: reason.skillName,
      requiredProficiency: reason.requiredProficiency,
      currentProficiency: reason.currentProficiency,
    } satisfies CapabilityGapLearnerReason;
  }
  return null;
}

// Completed work sorts after open work; everything else keeps the platform's
// existing convention of a deterministic comparator that ends on the id.
function compareAssignments(a: LearnerAssignment, b: LearnerAssignment): number {
  const aDone = a.status === "COMPLETED" ? 1 : 0;
  const bDone = b.status === "COMPLETED" ? 1 : 0;
  if (aDone !== bDone) return aDone - bDone;

  const aDue = a.dueDate?.getTime() ?? Number.POSITIVE_INFINITY;
  const bDue = b.dueDate?.getTime() ?? Number.POSITIVE_INFINITY;
  if (aDue !== bDue) return aDue < bDue ? -1 : 1;

  const created = a.createdAt.getTime() - b.createdAt.getTime();
  if (created !== 0) return created;

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The signed-in learner's own assignments.
 *
 * Identity comes only from `ctx`; both `userId` and `tenantId` scope the query,
 * so a row left over from a learner's previous tenant is never shown. A
 * cancelled assignment is not returned: the learner read contract (Phase 28A
 * §19) is "non-cancelled only". The row itself is kept for administrators, and
 * reactivating it makes it appear again.
 *
 * Status is derived, never stored, and always by `deriveAssignmentStatus`. The
 * data it needs is loaded in a fixed number of queries no matter how many
 * assignments there are (4 SQL statements, measured at 1, 12 and 40 rows):
 *   1. the assignments, with their course (Prisma batches the course relation
 *      into a single `IN` query)
 *   2. the learner's enrollments for those courses
 *   3. which of those courses the learner has any LessonProgress row in
 * "Started" is the same predicate the write path uses (a LessonProgress row
 * exists) — deliberately not filtered by lesson visibility, so a status seen at
 * creation and a status read here can never disagree (reconciled in Phase 28.4).
 */
export async function getLearnerAssignments(
  ctx: AuthContext,
  now: Date = new Date()
): Promise<LearnerAssignment[]> {
  requireRole(ctx, ["STUDENT"]);
  requireTenant(ctx);

  const rows: AssignmentRow[] = await db.learningAssignment.findMany({
    where: {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      cancelledAt: null,
      user: { deletedAt: null },
    },
    select: {
      id: true,
      courseId: true,
      source: true,
      reason: true,
      dueDate: true,
      cancelledAt: true,
      createdAt: true,
      course: { select: { title: true, slug: true } },
    },
  });
  if (rows.length === 0) return [];

  const courseIds = [...new Set(rows.map((row) => row.courseId))];

  const [enrollments, startedCourses] = await Promise.all([
    db.enrollment.findMany({
      where: { userId: ctx.userId, courseId: { in: courseIds } },
      select: { courseId: true, status: true },
    }),
    db.course.findMany({
      where: {
        id: { in: courseIds },
        sections: { some: { lessons: { some: { progress: { some: { userId: ctx.userId } } } } } },
      },
      select: { id: true },
    }),
  ]);

  const enrollmentStatusByCourse = new Map<string, EnrollmentStatus>(
    enrollments.map((e) => [e.courseId, e.status])
  );
  const startedCourseIds = new Set(startedCourses.map((c) => c.id));

  const assignments = rows.map((row): LearnerAssignment => {
    const base = {
      id: row.id,
      courseId: row.courseId,
      courseTitle: row.course.title,
      courseSlug: row.course.slug,
      dueDate: row.dueDate,
      createdAt: row.createdAt,
      status: deriveAssignmentStatus({
        cancelledAt: row.cancelledAt,
        dueDate: row.dueDate,
        enrollmentStatus: enrollmentStatusByCourse.get(row.courseId) ?? null,
        hasLessonProgress: startedCourseIds.has(row.courseId),
        now,
      }),
    };
    return {
      ...base,
      source: row.source,
      reason: projectReason(row.source, row.reason),
    } as LearnerAssignment;
  });

  return assignments.sort(compareAssignments);
}
