import type { EvidenceVerificationStatus, UserSkill } from "@/generated/prisma/client";
import type { AuthContext } from "@/lib/auth/context";
import { db } from "@/lib/db";
import { projectUserSkill } from "@/lib/domain/capability/proficiency";

export class CapabilityVerificationError extends Error {
  constructor(
    public status: 403 | 404,
    message: string
  ) {
    super(message);
    this.name = "CapabilityVerificationError";
  }
}

type ResolvedSourceCourse = { id: string; instructorId: string; tenantId: string | null };

/**
 * Resolves a SkillEvidence row's source back to the one Course whose
 * instructor is authorized to verify/reject it. Both Phase 5 evidence types
 * resolve to exactly one Course:
 *   COURSE_COMPLETION: sourceType="Course", sourceId is the Course id directly.
 *   QUIZ_SCORE: sourceType="QuizAttempt", sourceId -> QuizAttempt.quizId ->
 *     Quiz.lessonId -> Lesson.sectionId -> Section.courseId -> Course.
 * An unrecognized sourceType (none exist in Phase 5, but a future evidence
 * type might add one) resolves to null — fails closed, never verifiable
 * until this function is deliberately extended for it.
 */
async function resolveSourceCourse(evidence: {
  sourceType: string;
  sourceId: string | null;
}): Promise<ResolvedSourceCourse | null> {
  if (!evidence.sourceId) return null;

  if (evidence.sourceType === "Course") {
    return db.course.findUnique({
      where: { id: evidence.sourceId },
      select: { id: true, instructorId: true, tenantId: true },
    });
  }

  if (evidence.sourceType === "QuizAttempt") {
    const attempt = await db.quizAttempt.findUnique({
      where: { id: evidence.sourceId },
      select: {
        quiz: {
          select: {
            lesson: {
              select: {
                section: {
                  select: { course: { select: { id: true, instructorId: true, tenantId: true } } },
                },
              },
            },
          },
        },
      },
    });
    return attempt?.quiz.lesson.section.course ?? null;
  }

  return null;
}

/**
 * Authorization predicate (Phase 5 architecture challenge, Challenge 12):
 *   SUPER_ADMIN may verify/reject any evidence.
 *   INSTRUCTOR may verify/reject only evidence whose resolved source Course
 *     they own (course.instructorId === actor.userId).
 *   The evidence's own learner may never verify/reject their own evidence,
 *     regardless of role.
 * Deliberately not a general RBAC system — this is one predicate for one
 * action, mirroring the existing assignment-grading route's shape
 * (src/app/api/assignments/[assignmentId]/submissions/[submissionId]/grade/route.ts)
 * but corrected: that route's ownership check applies even to SUPER_ADMIN,
 * which this predicate deliberately does not replicate (a pre-existing
 * inconsistency there, not a pattern worth carrying forward here).
 */
async function authorizeVerificationActor(
  actor: AuthContext & { tenantId: string },
  evidence: { userId: string; tenantId: string; sourceType: string; sourceId: string | null }
): Promise<void> {
  if (evidence.userId === actor.userId) {
    throw new CapabilityVerificationError(403, "Cannot verify or reject your own evidence");
  }
  if (evidence.tenantId !== actor.tenantId) {
    throw new CapabilityVerificationError(403, "Forbidden");
  }

  // Source resolution is required for EVERY actor, SUPER_ADMIN included — the
  // locked contract is "SUPER_ADMIN may verify any valid evidence... subject
  // to normal source/tenant validation," not an unconditional bypass. A
  // malformed/unsupported sourceType must fail closed for everyone; only the
  // instructor-ownership comparison below is what SUPER_ADMIN skips.
  const course = await resolveSourceCourse(evidence);
  if (!course) {
    throw new CapabilityVerificationError(403, "Forbidden");
  }

  if (actor.role === "SUPER_ADMIN") return;
  if (actor.role !== "INSTRUCTOR") {
    throw new CapabilityVerificationError(403, "Forbidden");
  }
  if (course.instructorId !== actor.userId) {
    throw new CapabilityVerificationError(403, "Forbidden");
  }
}

/**
 * Shared implementation for verify/reject. The actor can only choose between
 * these two terminal actions — never submit a proficiency value directly.
 * The resulting UserSkill proficiency is always derived by
 * projectUserSkill's deterministic recompute over the full remaining
 * evidence set, never set directly by this function or its caller.
 */
async function setEvidenceVerificationStatus(
  actor: AuthContext & { tenantId: string },
  evidenceId: string,
  status: Extract<EvidenceVerificationStatus, "VERIFIED" | "REJECTED">
): Promise<UserSkill> {
  const evidence = await db.skillEvidence.findUnique({ where: { id: evidenceId } });
  if (!evidence) throw new CapabilityVerificationError(404, "Evidence not found");

  await authorizeVerificationActor(actor, evidence);

  return db.$transaction(async (tx) => {
    await tx.skillEvidence.update({
      where: { id: evidenceId },
      data:
        status === "VERIFIED"
          ? { verificationStatus: "VERIFIED", verifiedById: actor.userId, verifiedAt: new Date() }
          : { verificationStatus: "REJECTED" },
    });

    return projectUserSkill(tx, {
      tenantId: evidence.tenantId,
      userId: evidence.userId,
      skillId: evidence.skillId,
      changeTimestamp: new Date(),
    });
  });
}

export async function verifyEvidence(
  actor: AuthContext & { tenantId: string },
  evidenceId: string
): Promise<UserSkill> {
  return setEvidenceVerificationStatus(actor, evidenceId, "VERIFIED");
}

export async function rejectEvidence(
  actor: AuthContext & { tenantId: string },
  evidenceId: string
): Promise<UserSkill> {
  return setEvidenceVerificationStatus(actor, evidenceId, "REJECTED");
}
