import { db } from "@/lib/db";
import {
  type CourseCompletionEvidenceResult,
  recordCourseCompletionEvidence,
} from "@/lib/domain/capability/outcomes";

/**
 * Course-completion evidence reconciliation (Phase 24).
 *
 * SkillEvidence is created as a side effect of completing a course. Two
 * situations leave a COMPLETED enrollment with a valid CourseSkill mapping
 * but no evidence: (1) the completion request failed or was interrupted after
 * the enrollment flipped to COMPLETED, and (2) the CourseSkill was mapped
 * after the learner had already completed the course. Reconciliation closes
 * both, using the same evidence writer as the live completion path, so the
 * existing [tenantId, userId, skillId, sourceType, sourceId] unique
 * constraint keeps every call idempotent and concurrency-safe: it only ever
 * creates evidence that is missing and never touches evidence that exists
 * (including VERIFIED or REJECTED rows), and UserSkill is only ever
 * re-projected upward from the full evidence set, never downgraded.
 */

export type CourseCompletionReconciliationResult = {
  created: number;
  alreadyPresent: number;
  skipped: CourseCompletionEvidenceResult["skipped"] | "not-completed";
};

export type CourseCompletionReconciliationParams = {
  tenantId: string;
  userId: string;
  courseId: string;
  /** Restrict to these skills (a newly mapped CourseSkill). Omitted = every valid mapping. */
  skillIds?: string[];
};

/**
 * Creates any missing COURSE_COMPLETION evidence for one learner and one
 * course. All three boundaries are explicit and re-verified server-side: the
 * course must belong to `tenantId`, the learner must belong to `tenantId`,
 * and the learner must have a COMPLETED enrollment in the course. Anything
 * else is a deliberate skip, never evidence. Throws
 * CourseCompletionEvidenceError if a write genuinely fails — the call is
 * idempotent, so the remedy is to call it again.
 */
export async function reconcileCourseCompletionEvidence(
  params: CourseCompletionReconciliationParams
): Promise<CourseCompletionReconciliationResult> {
  const { tenantId, userId, courseId, skillIds } = params;

  const [course, user, enrollment] = await Promise.all([
    db.course.findUnique({ where: { id: courseId }, select: { tenantId: true } }),
    db.user.findUnique({ where: { id: userId }, select: { tenantId: true } }),
    db.enrollment.findUnique({
      where: { userId_courseId: { userId, courseId } },
      select: { status: true, completedAt: true, updatedAt: true },
    }),
  ]);

  if (!course) return { created: 0, alreadyPresent: 0, skipped: "course-not-found" };
  if (course.tenantId !== tenantId || !user || user.tenantId !== tenantId) {
    return { created: 0, alreadyPresent: 0, skipped: "tenant-mismatch" };
  }
  if (!enrollment || enrollment.status !== "COMPLETED") {
    return { created: 0, alreadyPresent: 0, skipped: "not-completed" };
  }

  return recordCourseCompletionEvidence({
    tenantId,
    userId,
    courseId,
    occurredAt: enrollment.completedAt ?? enrollment.updatedAt,
    skillIds,
  });
}

export type CourseSkillBackfillResult = {
  /** COMPLETED same-tenant enrollments in the course. */
  considered: number;
  created: number;
  alreadyPresent: number;
  /** Learners whose write failed; each is safe to reconcile again. */
  failed: string[];
};

/**
 * Backfills exactly one newly mapped CourseSkill for the learners who had
 * already completed the course. Deliberately narrow: only the given skill,
 * only COMPLETED enrollments, only learners in the course's own tenant —
 * never a general historical evidence migration. A failure for one learner
 * is recorded and logged but never stops the rest.
 */
export async function reconcileCompletedLearnersForCourseSkill(params: {
  tenantId: string;
  courseId: string;
  skillId: string;
}): Promise<CourseSkillBackfillResult> {
  const { tenantId, courseId, skillId } = params;
  const result: CourseSkillBackfillResult = {
    considered: 0,
    created: 0,
    alreadyPresent: 0,
    failed: [],
  };

  const course = await db.course.findUnique({
    where: { id: courseId },
    select: { tenantId: true },
  });
  if (!course || course.tenantId !== tenantId) return result;

  const enrollments = await db.enrollment.findMany({
    where: { courseId, status: "COMPLETED", user: { tenantId } },
    select: { userId: true },
  });
  result.considered = enrollments.length;
  if (enrollments.length === 0) return result;

  // Learners who already hold evidence for this course/skill (any status,
  // including REJECTED) are left exactly as they are.
  const existing = await db.skillEvidence.findMany({
    where: {
      tenantId,
      skillId,
      sourceType: "Course",
      sourceId: courseId,
      userId: { in: enrollments.map((e) => e.userId) },
    },
    select: { userId: true },
  });
  const alreadyHave = new Set(existing.map((e) => e.userId));
  result.alreadyPresent = alreadyHave.size;

  for (const { userId } of enrollments) {
    if (alreadyHave.has(userId)) continue;
    try {
      const outcome = await reconcileCourseCompletionEvidence({
        tenantId,
        userId,
        courseId,
        skillIds: [skillId],
      });
      result.created += outcome.created;
      result.alreadyPresent += outcome.alreadyPresent;
    } catch (err) {
      result.failed.push(userId);
      console.error(
        `[capability] Failed to backfill completion evidence (course ${courseId}, skill ${skillId}, user ${userId})`,
        err
      );
    }
  }

  return result;
}
