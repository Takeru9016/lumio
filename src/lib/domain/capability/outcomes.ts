import type { EvidenceType } from "@/generated/prisma/client";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { projectUserSkill } from "@/lib/domain/capability/proficiency";
import { assertSameTenant, KnowledgeAccessError } from "@/lib/domain/knowledge/access";
import { emitLearningEvent } from "@/lib/domain/learning-events/emit";

/**
 * Creates one SkillEvidence row and projects UserSkill for it, atomically,
 * in its own transaction — one transaction PER SKILL, not one transaction
 * for an entire multi-skill course completion. This matters under Postgres:
 * once a statement inside a transaction fails (e.g. our own unique-
 * constraint violation), the whole transaction is aborted and every later
 * statement in it fails too — so batching several skills' evidence writes
 * into one shared transaction would mean a duplicate on skill #2 silently
 * discards skill #1 and #3's legitimate new evidence on every retry. Each
 * skill gets its own independent atomic unit instead.
 *
 * A unique-constraint violation (P2002, on SkillEvidence's
 * [tenantId, userId, skillId, sourceType, sourceId] constraint) means a
 * concurrent or retried call already recorded this exact evidence — the
 * database constraint is the real concurrency guarantee (not this
 * function's lack of a pre-check), so that transaction rolled back cleanly
 * and this is treated as a benign, idempotent no-op: the winning concurrent
 * transaction already created the evidence AND projected UserSkill for it,
 * atomically, in its own call to this same function.
 *
 * Resolves `true` when this call created the evidence, `false` when it
 * already existed (the idempotent no-op above).
 */
export async function recordSkillEvidenceOutcome(params: {
  tenantId: string;
  userId: string;
  skillId: string;
  type: EvidenceType;
  sourceType: string;
  sourceId: string;
  score?: number;
  occurredAt: Date;
}): Promise<boolean> {
  const { tenantId, userId, skillId, type, sourceType, sourceId, score, occurredAt } = params;
  try {
    await db.$transaction(async (tx) => {
      await tx.skillEvidence.create({
        data: {
          tenantId,
          userId,
          skillId,
          type,
          sourceType,
          sourceId,
          score,
          verificationStatus: "UNVERIFIED",
        },
      });
      await projectUserSkill(tx, { tenantId, userId, skillId, changeTimestamp: occurredAt });
    });
    return true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return false;
    }
    throw err;
  }
}

/**
 * Resolves a course's CourseSkill mappings, filtering out any mapping whose
 * Skill belongs to a different tenant than the course/caller — a real,
 * documented, pre-existing gap (no DB constraint requires CourseSkill's
 * Course and Skill to share a tenant, same class of issue as Phase 1's
 * RoleSkill finding). A malformed mapping is skipped and logged, never
 * trusted into evidence creation, and never allowed to block the other,
 * valid mappings for the same course.
 */
export async function resolveValidCourseSkillMappings(
  tenantId: string,
  courseId: string
): Promise<{ skillId: string }[]> {
  const mappings = await db.courseSkill.findMany({
    where: { courseId },
    select: { skillId: true, skill: { select: { tenantId: true } } },
  });

  const valid: { skillId: string }[] = [];
  for (const mapping of mappings) {
    try {
      assertSameTenant(tenantId, [{ tenantId: mapping.skill.tenantId, label: "Skill" }]);
      valid.push({ skillId: mapping.skillId });
    } catch (err) {
      console.warn(
        `[capability] Skipping cross-tenant CourseSkill mapping (skill ${mapping.skillId}, course ${courseId})`,
        err
      );
    }
  }
  return valid;
}

export type CourseCompletionEvidenceParams = {
  tenantId: string;
  userId: string;
  courseId: string;
  occurredAt: Date;
  /**
   * Restricts recording to these skills — used when a single new CourseSkill
   * is being reconciled. Omitted means every valid mapping of the course.
   */
  skillIds?: string[];
};

export type CourseCompletionEvidenceResult = {
  created: number;
  alreadyPresent: number;
  /** Why nothing was attempted, when that is a deliberate skip rather than a failure. */
  skipped: "course-not-found" | "tenant-mismatch" | null;
};

/**
 * One or more skills' evidence writes failed for a reason other than the
 * benign duplicate (P2002). Thrown only after every mapped skill has been
 * attempted, so one failing skill never blocks the others. The write is
 * idempotent, so the fix for this error is simply to run it again — see
 * reconciliation.ts.
 */
export class CourseCompletionEvidenceError extends Error {
  constructor(
    public courseId: string,
    public userId: string,
    public failures: { skillId: string; error: unknown }[]
  ) {
    super(
      `Failed to record course-completion evidence for course ${courseId}, user ${userId} (skills: ${failures
        .map((f) => f.skillId)
        .join(", ")})`,
      { cause: failures[0]?.error }
    );
    this.name = "CourseCompletionEvidenceError";
  }
}

/**
 * Records COURSE_COMPLETION evidence for a learner's completion of a course.
 * This is the single evidence-writing routine shared by the live completion
 * path (recordCourseCompletionOutcome) and reconciliation.ts, so both produce
 * byte-identical evidence and are protected by the same
 * [tenantId, userId, skillId, sourceType, sourceId] unique constraint.
 *
 * It does NOT check that the enrollment is COMPLETED — callers own that
 * proof (the completion route's atomic transition, or reconciliation's
 * explicit enrollment check). It does enforce the tenant boundary, skips
 * cross-tenant CourseSkill mappings, and — unlike the original catch-all —
 * lets genuine failures surface instead of swallowing them.
 */
export async function recordCourseCompletionEvidence(
  params: CourseCompletionEvidenceParams
): Promise<CourseCompletionEvidenceResult> {
  const { tenantId, userId, courseId, occurredAt, skillIds } = params;

  const course = await db.course.findUnique({
    where: { id: courseId },
    select: { id: true, tenantId: true },
  });
  if (!course) return { created: 0, alreadyPresent: 0, skipped: "course-not-found" };

  try {
    assertSameTenant(tenantId, [{ tenantId: course.tenantId ?? "", label: "Course" }]);
  } catch (err) {
    if (err instanceof KnowledgeAccessError) {
      console.warn(`[capability] Skipping evidence for course ${courseId}: tenant mismatch`, err);
      return { created: 0, alreadyPresent: 0, skipped: "tenant-mismatch" };
    }
    throw err;
  }

  const validMappings = await resolveValidCourseSkillMappings(tenantId, course.id);
  const mappings = skillIds
    ? validMappings.filter((mapping) => skillIds.includes(mapping.skillId))
    : validMappings;

  // Skip the write for evidence that is already there so a repeated call
  // (every completion request on an already-completed course reconciles) does
  // not issue a doomed INSERT per skill. This is an optimization only — the
  // unique constraint, handled as P2002 below, remains the actual guarantee
  // for concurrent callers.
  const existing =
    mappings.length === 0
      ? []
      : await db.skillEvidence.findMany({
          where: {
            tenantId,
            userId,
            sourceType: "Course",
            sourceId: course.id,
            skillId: { in: mappings.map((mapping) => mapping.skillId) },
          },
          select: { skillId: true },
        });
  const alreadyRecorded = new Set(existing.map((row) => row.skillId));

  let created = 0;
  let alreadyPresent = 0;
  const failures: { skillId: string; error: unknown }[] = [];

  for (const mapping of mappings) {
    if (alreadyRecorded.has(mapping.skillId)) {
      alreadyPresent += 1;
      continue;
    }
    try {
      const wasCreated = await recordSkillEvidenceOutcome({
        tenantId,
        userId,
        skillId: mapping.skillId,
        type: "COURSE_COMPLETION",
        sourceType: "Course",
        sourceId: course.id,
        occurredAt,
      });
      if (wasCreated) created += 1;
      else alreadyPresent += 1;
    } catch (error) {
      failures.push({ skillId: mapping.skillId, error });
    }
  }

  if (failures.length > 0) throw new CourseCompletionEvidenceError(course.id, userId, failures);

  return { created, alreadyPresent, skipped: null };
}

export type CourseCompletionOutcomeParams = {
  tenantId: string;
  userId: string;
  courseId: string;
  enrollmentId: string;
  completedAt: Date;
};

/**
 * The entry point the course-completion route calls once it has won the
 * atomic enrollment transition. Owns both outputs of the Phase 5
 * architecture (see docs/V2_AI_ARCHITECTURE.md, "AI Course Creator" for the
 * analogous READ/GENERATE-vs-application-WRITE separation pattern this
 * mirrors):
 *
 *   Trusted outcome -> SkillEvidence -> UserSkill   (atomic, per skill)
 *   Trusted outcome -> LearningEvent                (best-effort, after)
 *
 * A LearningEvent failure is logged and never thrown. An evidence failure is
 * different (Phase 24): it is no longer swallowed — the LearningEvent is
 * still attempted, then the evidence error is rethrown so the caller can
 * isolate it from unrelated completion side effects and surface it. The
 * evidence write is idempotent and reconcilable, so a rethrown failure is
 * always safe to retry (reconciliation.ts).
 */
export async function recordCourseCompletionOutcome(
  params: CourseCompletionOutcomeParams
): Promise<void> {
  const { tenantId, userId, courseId, enrollmentId, completedAt } = params;

  let evidenceFailure: unknown = null;
  try {
    await recordCourseCompletionEvidence({ tenantId, userId, courseId, occurredAt: completedAt });
  } catch (err) {
    evidenceFailure = err;
  }

  try {
    await emitLearningEvent({
      tenantId,
      userId,
      eventType: "COURSE_COMPLETED",
      entityType: "Course",
      entityId: courseId,
      occurredAt: completedAt,
      metadata: { enrollmentId },
    });
  } catch (err) {
    console.error(
      `[capability] Failed to emit COURSE_COMPLETED LearningEvent for ${courseId}`,
      err
    );
  }

  if (evidenceFailure) throw evidenceFailure;
}

export type QuizOutcomeParams = {
  tenantId: string;
  userId: string;
  quizId: string;
  attemptId: string;
  score: number;
  isPassed: boolean;
  occurredAt: Date;
};

/**
 * Skills for which this learner already holds quiz evidence written before
 * Phase 25, when each passing attempt got its own row keyed by the attempt id
 * (sourceType "QuizAttempt"). Those rows are historical and are never touched;
 * this only lets a later pass recognise that the learner already has quiz
 * evidence for the skill, so the "one row per learner, quiz and skill" rule
 * holds across the change instead of adding one more row to a learner who
 * already has several. Legacy rows are never written any more, so this set
 * cannot grow and needs no concurrency protection.
 */
async function skillsWithLegacyQuizEvidence(params: {
  tenantId: string;
  userId: string;
  quizId: string;
  skillIds: string[];
}): Promise<Set<string>> {
  const { tenantId, userId, quizId, skillIds } = params;
  if (skillIds.length === 0) return new Set();

  const attempts = await db.quizAttempt.findMany({
    where: { userId, quizId },
    select: { id: true },
  });
  if (attempts.length === 0) return new Set();

  const rows = await db.skillEvidence.findMany({
    where: {
      tenantId,
      userId,
      sourceType: "QuizAttempt",
      sourceId: { in: attempts.map((attempt) => attempt.id) },
      skillId: { in: skillIds },
    },
    select: { skillId: true },
  });
  return new Set(rows.map((row) => row.skillId));
}

/**
 * The single entry point the quiz-attempt route calls. QUIZ_COMPLETED is
 * always emitted (pass or fail); SkillEvidence is only ever created when
 * `isPassed` — a failed quiz is a real, recorded learning event with
 * deliberately zero capability-state effect (no negative/degrading
 * evidence — no product requirement establishes what that would even mean).
 *
 * Quiz evidence is keyed by the QUIZ, not the attempt (sourceType "Quiz",
 * sourceId = quizId; tenant, learner and skill are already part of the unique
 * key). However many attempts a learner passes, there is at most one QUIZ_SCORE
 * row per learner, quiz and skill: the first pass creates it and every later
 * pass hits the same unique constraint (P2002 -> a benign no-op inside
 * recordSkillEvidenceOutcome), which is also what makes concurrent passing
 * attempts safe. The row keeps the score of the pass that created it. The
 * attempt itself is still recorded (QuizAttempt, and the per-attempt
 * QUIZ_COMPLETED LearningEvent).
 */
export async function recordQuizOutcome(params: QuizOutcomeParams): Promise<void> {
  const { tenantId, userId, quizId, attemptId, score, isPassed, occurredAt } = params;

  let courseId: string | undefined;

  if (isPassed) {
    const quiz = await db.quiz.findUnique({
      where: { id: quizId },
      select: {
        lesson: {
          select: { section: { select: { course: { select: { id: true, tenantId: true } } } } },
        },
      },
    });

    if (quiz) {
      const course = quiz.lesson.section.course;
      courseId = course.id;
      try {
        assertSameTenant(tenantId, [{ tenantId: course.tenantId ?? "", label: "Course" }]);
        const mappings = await resolveValidCourseSkillMappings(tenantId, course.id);
        const legacy = await skillsWithLegacyQuizEvidence({
          tenantId,
          userId,
          quizId,
          skillIds: mappings.map((mapping) => mapping.skillId),
        });
        for (const mapping of mappings) {
          if (legacy.has(mapping.skillId)) continue;
          await recordSkillEvidenceOutcome({
            tenantId,
            userId,
            skillId: mapping.skillId,
            type: "QUIZ_SCORE",
            sourceType: "Quiz",
            sourceId: quizId,
            score,
            occurredAt,
          });
        }
      } catch (err) {
        if (err instanceof KnowledgeAccessError) {
          console.warn(
            `[capability] Skipping evidence for quiz ${quizId}: course tenant mismatch`,
            err
          );
        } else {
          console.error(
            `[capability] Failed to record quiz-score evidence for attempt ${attemptId}`,
            err
          );
        }
      }
    }
  }

  try {
    await emitLearningEvent({
      tenantId,
      userId,
      eventType: "QUIZ_COMPLETED",
      entityType: "QuizAttempt",
      entityId: attemptId,
      occurredAt,
      metadata: { quizId, score, isPassed, courseId },
    });
  } catch (err) {
    console.error(
      `[capability] Failed to emit QUIZ_COMPLETED LearningEvent for attempt ${attemptId}`,
      err
    );
  }
}

export type AssignmentGradeOutcomeParams = {
  tenantId: string;
  userId: string;
  assignmentId: string;
  submissionId: string;
  score: number;
  maxScore: number;
  occurredAt: Date;
};

/**
 * The single entry point the assignment-grading route calls. Phase 17:
 * assignments have no pass/fail concept anywhere in the schema (unlike
 * Quiz.passingScore), so — per the locked contract — every successfully
 * graded submission qualifies for ASSESSMENT evidence; score magnitude does
 * not gate evidence creation. sourceId is the submission's id, which is
 * stable across regrades (AssignmentSubmission is unique per
 * [userId, assignmentId]), so a regrade that still qualifies (always true
 * here) hits the same SkillEvidence P2002 no-op as quiz's regrading case —
 * first grade's evidence wins, a later regrade never updates or removes it.
 * ASSIGNMENT_GRADED is always emitted; metadata omits any pass/fail field
 * rather than inventing one.
 */
export async function recordAssignmentGradeOutcome(
  params: AssignmentGradeOutcomeParams
): Promise<void> {
  const { tenantId, userId, assignmentId, submissionId, score, maxScore, occurredAt } = params;

  const assignment = await db.assignment.findUnique({
    where: { id: assignmentId },
    select: {
      lesson: {
        select: { section: { select: { course: { select: { id: true, tenantId: true } } } } },
      },
    },
  });

  let courseId: string | undefined;

  if (assignment) {
    const course = assignment.lesson.section.course;
    courseId = course.id;
    try {
      assertSameTenant(tenantId, [{ tenantId: course.tenantId ?? "", label: "Course" }]);
      const mappings = await resolveValidCourseSkillMappings(tenantId, course.id);
      for (const mapping of mappings) {
        await recordSkillEvidenceOutcome({
          tenantId,
          userId,
          skillId: mapping.skillId,
          type: "ASSESSMENT",
          sourceType: "AssignmentSubmission",
          sourceId: submissionId,
          score,
          occurredAt,
        });
      }
    } catch (err) {
      if (err instanceof KnowledgeAccessError) {
        console.warn(
          `[capability] Skipping evidence for assignment ${assignmentId}: course tenant mismatch`,
          err
        );
      } else {
        console.error(
          `[capability] Failed to record assessment evidence for submission ${submissionId}`,
          err
        );
      }
    }
  }

  try {
    await emitLearningEvent({
      tenantId,
      userId,
      eventType: "ASSIGNMENT_GRADED",
      entityType: "AssignmentSubmission",
      entityId: submissionId,
      occurredAt,
      metadata: { assignmentId, courseId, score, maxScore },
    });
  } catch (err) {
    console.error(
      `[capability] Failed to emit ASSIGNMENT_GRADED LearningEvent for submission ${submissionId}`,
      err
    );
  }
}
