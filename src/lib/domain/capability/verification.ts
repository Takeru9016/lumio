import type {
  EvidenceType,
  EvidenceVerificationStatus,
  UserSkill,
} from "@/generated/prisma/client";
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

type ResolvedSourceCourse = {
  id: string;
  instructorId: string;
  tenantId: string | null;
  title: string;
};

/**
 * Resolves a SkillEvidence row's source back to the one Course whose
 * instructor is authorized to verify/reject it. Every evidence type with a
 * production writer (src/lib/domain/capability/outcomes.ts) resolves to
 * exactly one Course:
 *   COURSE_COMPLETION: sourceType="Course", sourceId is the Course id directly.
 *   QUIZ_SCORE: sourceType="Quiz", sourceId -> Quiz.lessonId ->
 *     Lesson.sectionId -> Section.courseId -> Course. (Phase 25 — quiz evidence
 *     is keyed by the quiz.) Evidence written before Phase 25 has
 *     sourceType="QuizAttempt", sourceId -> QuizAttempt.quizId -> the same
 *     Quiz chain; those historical rows still resolve.
 *   ASSESSMENT: sourceType="AssignmentSubmission", sourceId ->
 *     AssignmentSubmission.assignmentId -> Assignment.lessonId ->
 *     Lesson.sectionId -> Section.courseId -> Course. (Phase 20 — this branch
 *     was missing since Phase 17 added ASSESSMENT evidence, which meant
 *     assignment-grade evidence silently failed closed for every actor,
 *     including SUPER_ADMIN, and could never be verified.)
 * An unrecognized sourceType (none exist in production today) resolves to
 * null — fails closed, never verifiable until this function is deliberately
 * extended for it.
 */
export async function resolveSourceCourse(evidence: {
  sourceType: string;
  sourceId: string | null;
}): Promise<ResolvedSourceCourse | null> {
  if (!evidence.sourceId) return null;

  if (evidence.sourceType === "Course") {
    return db.course.findUnique({
      where: { id: evidence.sourceId },
      select: { id: true, instructorId: true, tenantId: true, title: true },
    });
  }

  if (evidence.sourceType === "Quiz") {
    const quiz = await db.quiz.findUnique({
      where: { id: evidence.sourceId },
      select: {
        lesson: {
          select: {
            section: {
              select: {
                course: {
                  select: { id: true, instructorId: true, tenantId: true, title: true },
                },
              },
            },
          },
        },
      },
    });
    return quiz?.lesson.section.course ?? null;
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
                  select: {
                    course: {
                      select: { id: true, instructorId: true, tenantId: true, title: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    return attempt?.quiz.lesson.section.course ?? null;
  }

  if (evidence.sourceType === "AssignmentSubmission") {
    const submission = await db.assignmentSubmission.findUnique({
      where: { id: evidence.sourceId },
      select: {
        assignment: {
          select: {
            lesson: {
              select: {
                section: {
                  select: {
                    course: {
                      select: { id: true, instructorId: true, tenantId: true, title: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    return submission?.assignment.lesson.section.course ?? null;
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
    // Phase 30.2 — `revision` is incremented on every audited transition of
    // this row (schema comment, prisma/schema.prisma), and
    // SkillProficiencyEvent's `[evidenceId, evidenceRevision]` unique
    // constraint (shipped in 30.1) depends on it actually moving: without
    // this increment, verify-then-reject on the same evidence row would
    // stamp two events at revision 0 and the reject's event insert would
    // fail its own unique constraint — a real collision this repo's own
    // tests exercise (verification.test.ts's verify-then-reject cases).
    const updatedEvidence = await tx.skillEvidence.update({
      where: { id: evidenceId },
      data:
        status === "VERIFIED"
          ? {
              verificationStatus: "VERIFIED",
              verifiedById: actor.userId,
              verifiedAt: new Date(),
              revision: { increment: 1 },
            }
          : { verificationStatus: "REJECTED", revision: { increment: 1 } },
    });

    return projectUserSkill(tx, {
      tenantId: evidence.tenantId,
      userId: evidence.userId,
      skillId: evidence.skillId,
      changeTimestamp: new Date(),
      cause: status === "VERIFIED" ? "EVIDENCE_VERIFIED" : "EVIDENCE_REJECTED",
      evidenceId,
      evidenceRevision: updatedEvidence.revision,
      actorId: actor.userId,
      actorRole: actor.role,
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

export type ReviewableEvidenceRow = {
  id: string;
  skillId: string;
  skillName: string;
  type: EvidenceType;
  sourceType: string;
  score: number | null;
  verificationStatus: EvidenceVerificationStatus;
  courseTitle: string;
  createdAt: Date;
};

/**
 * Phase 20 — the reviewable-evidence read path for the instructor student-
 * detail page. Scoped identically to the mutation path above: an
 * INSTRUCTOR-only actor (ORG_ADMIN is deliberately not granted this — see
 * the Phase 20 contract, "Authorization"), a student the actor has an
 * actual shared enrollment with (mirrors getInstructorStudentDetail's own
 * "no shared course = same as not found" convention — see
 * src/lib/instructor-students.ts), and, per evidence row, only rows whose
 * resolved source Course the actor actually owns — reusing
 * `resolveSourceCourse` rather than re-deriving a parallel join, so a
 * student enrolled with multiple instructors never has another
 * instructor's course evidence exposed here.
 *
 * Returns null for "not authorized to view this student at all" (caller
 * should 404, matching getInstructorStudentDetail) — an empty array means
 * "authorized, but no evidence yet."
 */
export async function getReviewableEvidenceForInstructor(
  actor: AuthContext & { tenantId: string },
  studentId: string
): Promise<ReviewableEvidenceRow[] | null> {
  if (actor.role !== "INSTRUCTOR") return null;

  const sharedEnrollment = await db.enrollment.findFirst({
    where: { userId: studentId, course: { instructorId: actor.userId, tenantId: actor.tenantId } },
    select: { id: true },
  });
  if (!sharedEnrollment) return null;

  const rows = await db.skillEvidence.findMany({
    where: { tenantId: actor.tenantId, userId: studentId },
    select: {
      id: true,
      skillId: true,
      type: true,
      sourceType: true,
      sourceId: true,
      score: true,
      verificationStatus: true,
      createdAt: true,
      skill: { select: { name: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
  });

  const reviewable: ReviewableEvidenceRow[] = [];
  for (const row of rows) {
    const course = await resolveSourceCourse(row);
    if (!course || course.instructorId !== actor.userId) continue;
    reviewable.push({
      id: row.id,
      skillId: row.skillId,
      skillName: row.skill.name,
      type: row.type,
      sourceType: row.sourceType,
      score: row.score,
      verificationStatus: row.verificationStatus,
      courseTitle: course.title,
      createdAt: row.createdAt,
    });
  }

  return reviewable;
}
