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
 */
async function recordSkillEvidenceOutcome(params: {
  tenantId: string;
  userId: string;
  skillId: string;
  type: EvidenceType;
  sourceType: string;
  sourceId: string;
  score?: number;
  occurredAt: Date;
}): Promise<void> {
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
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return;
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
async function resolveValidCourseSkillMappings(
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

export type CourseCompletionOutcomeParams = {
  tenantId: string;
  userId: string;
  courseId: string;
  enrollmentId: string;
  completedAt: Date;
};

/**
 * The single entry point the course-completion route calls. Owns both
 * outputs of the Phase 5 architecture (see docs/V2_AI_ARCHITECTURE.md,
 * "AI Course Creator" for the analogous READ/GENERATE-vs-application-WRITE
 * separation pattern this mirrors):
 *
 *   Trusted outcome -> SkillEvidence -> UserSkill   (atomic, per skill)
 *   Trusted outcome -> LearningEvent                (best-effort, after)
 *
 * Never throws on a LearningEvent failure — the caller (the completion
 * route) must not have its response affected by this function's evidence or
 * event-emission behavior beyond having called it.
 */
export async function recordCourseCompletionOutcome(
  params: CourseCompletionOutcomeParams
): Promise<void> {
  const { tenantId, userId, courseId, enrollmentId, completedAt } = params;

  const course = await db.course.findUnique({
    where: { id: courseId },
    select: { id: true, tenantId: true },
  });

  if (course) {
    try {
      assertSameTenant(tenantId, [{ tenantId: course.tenantId ?? "", label: "Course" }]);
      const mappings = await resolveValidCourseSkillMappings(tenantId, courseId);
      for (const mapping of mappings) {
        await recordSkillEvidenceOutcome({
          tenantId,
          userId,
          skillId: mapping.skillId,
          type: "COURSE_COMPLETION",
          sourceType: "Course",
          sourceId: course.id,
          occurredAt: completedAt,
        });
      }
    } catch (err) {
      if (err instanceof KnowledgeAccessError) {
        console.warn(`[capability] Skipping evidence for course ${courseId}: tenant mismatch`, err);
      } else {
        console.error(
          `[capability] Failed to record course-completion evidence for ${courseId}`,
          err
        );
      }
    }
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
 * The single entry point the quiz-attempt route calls. QUIZ_COMPLETED is
 * always emitted (pass or fail); SkillEvidence is only ever created when
 * `isPassed` — a failed quiz is a real, recorded learning event with
 * deliberately zero capability-state effect (no negative/degrading
 * evidence — no product requirement establishes what that would even mean).
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
        for (const mapping of mappings) {
          await recordSkillEvidenceOutcome({
            tenantId,
            userId,
            skillId: mapping.skillId,
            type: "QUIZ_SCORE",
            sourceType: "QuizAttempt",
            sourceId: attemptId,
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
