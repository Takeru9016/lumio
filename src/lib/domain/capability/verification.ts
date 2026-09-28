import type {
  EvidenceState,
  EvidenceType,
  EvidenceVerificationStatus,
  UserSkill,
} from "@/generated/prisma/client";
import type { AuthContext } from "@/lib/auth/context";
import { db } from "@/lib/db";
import {
  type EvidenceTransitionAction,
  evaluateTransition,
  isVerificationAxisAction,
  PROFICIENCY_CAUSE_FOR_ACTION,
  reasonRequired,
  requiresSourceResolution,
  roleMayAttempt,
  stateTargetFor,
  verificationTargetFor,
} from "@/lib/domain/capability/evidenceTransitions";
import { projectUserSkill } from "@/lib/domain/capability/proficiency";

export class CapabilityVerificationError extends Error {
  constructor(
    public status: 403 | 404 | 409,
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

type LockedEvidenceRow = {
  id: string;
  tenantId: string;
  userId: string;
  skillId: string;
  sourceType: string;
  sourceId: string | null;
  verificationStatus: EvidenceVerificationStatus;
  state: EvidenceState;
  revision: number;
};

/**
 * The one canonical entry point for every evidence-standing transition
 * (docs/PHASE_30.3_DISCOVERY.md §13/§14/§15/§24/§25/§26, contract §Q). Locks
 * the `SkillEvidence` row first (`SELECT ... FOR UPDATE`), then `UserSkill`
 * via `projectUserSkill` inside the same transaction — the fixed lock order
 * documented in the discovery (§14/§34 D21), so a verification transaction
 * and a concurrent evidence-creation transaction can never deadlock against
 * each other.
 *
 * Check order, exactly as specified (docs/PHASE_30.3_DISCOVERY.md §14):
 *   1. lock the row
 *   2. tenant mismatch -> the SAME 404 as missing (D23 — closes a real,
 *      pre-existing existence leak: the old code returned a distinguishable
 *      403 for a cross-tenant evidenceId)
 *   3. the subject may never act on their own evidence -> 403
 *   4. the evidence's learner is soft-deleted -> 403 (D22 — a real,
 *      pre-existing gap; nothing previously checked this)
 *   5. the actor's role is not even a candidate for this action -> 403
 *      (coarse gate, before any state-legality info could leak)
 *   6. the transition itself: NOT_ACTIVE or ILLEGAL_TRANSITION -> 409
 *   7. source resolution + course tenant/ownership, for verification-axis
 *      actions only (§25's per-action table — revoke/reinstate never
 *      require it, since correcting evidence with an unresolvable source is
 *      their entire purpose)
 *   8. no-op -> return the current UserSkill unchanged, no writes at all
 *   9. apply -> bump revision, write SkillEvidence, write ONE
 *      EvidenceStandingEvent (always, regardless of whether the level
 *      moves), then projectUserSkill (which writes a SkillProficiencyEvent
 *      only if the level actually changed — 30.2's rule, not reopened)
 */
async function applyEvidenceTransition(
  actor: AuthContext & { tenantId: string },
  evidenceId: string,
  action: EvidenceTransitionAction,
  opts: { reason?: string } = {}
): Promise<UserSkill> {
  const reason = opts.reason?.trim();
  if (reasonRequired(action) && !reason) {
    throw new CapabilityVerificationError(403, "A reason is required for this action");
  }

  return db.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<LockedEvidenceRow[]>`
      SELECT id, "tenantId", "userId", "skillId", "sourceType", "sourceId",
             "verificationStatus", "state", "revision"
      FROM "SkillEvidence"
      WHERE id = ${evidenceId}
      FOR UPDATE
    `;

    if (!locked || locked.tenantId !== actor.tenantId) {
      throw new CapabilityVerificationError(404, "Evidence not found");
    }
    if (locked.userId === actor.userId) {
      throw new CapabilityVerificationError(403, "Cannot act on your own evidence");
    }

    const learner = await tx.user.findUnique({
      where: { id: locked.userId },
      select: { deletedAt: true },
    });
    if (!learner || learner.deletedAt !== null) {
      throw new CapabilityVerificationError(403, "Forbidden");
    }

    if (!roleMayAttempt(action, actor.role)) {
      throw new CapabilityVerificationError(403, "Forbidden");
    }

    const evaluation = evaluateTransition(action, {
      verificationStatus: locked.verificationStatus,
      state: locked.state,
    });
    if (evaluation.outcome === "refuse") {
      throw new CapabilityVerificationError(
        409,
        evaluation.code === "NOT_ACTIVE"
          ? "Evidence is not active — reinstate it first"
          : `Cannot apply this action to evidence currently at ${locked.verificationStatus}/${locked.state}`
      );
    }

    if (requiresSourceResolution(action)) {
      const course = await resolveSourceCourse(locked);
      if (!course || course.tenantId !== actor.tenantId) {
        throw new CapabilityVerificationError(403, "Forbidden");
      }
      if (actor.role === "INSTRUCTOR" && course.instructorId !== actor.userId) {
        throw new CapabilityVerificationError(403, "Forbidden");
      }
    }

    if (evaluation.outcome === "no-op") {
      // Never call projectUserSkill here: it is a full recompute, and for a
      // stored level above what Policy 1 can grant (e.g. legacy ADVANCED)
      // it would silently converge proficiency downward on a plain re-verify.
      const existing = await tx.userSkill.findUnique({
        where: { userId_skillId: { userId: locked.userId, skillId: locked.skillId } },
      });
      if (existing) return existing;
      return projectUserSkill(tx, {
        tenantId: actor.tenantId,
        userId: locked.userId,
        skillId: locked.skillId,
        changeTimestamp: new Date(),
        cause: "RECALCULATED",
      });
    }

    const actorRow = await tx.user.findUnique({
      where: { id: actor.userId },
      select: { name: true },
    });
    const now = new Date();

    let newVerificationStatus = locked.verificationStatus;
    let newState = locked.state;
    const updateData: {
      revision: { increment: number };
      verificationStatus?: EvidenceVerificationStatus;
      state?: EvidenceState;
      verifiedById?: string;
      verifiedAt?: Date;
    } = { revision: { increment: 1 } };

    if (isVerificationAxisAction(action)) {
      newVerificationStatus = verificationTargetFor(action);
      updateData.verificationStatus = newVerificationStatus;
      if (action === "VERIFY") {
        updateData.verifiedById = actor.userId;
        updateData.verifiedAt = now;
      }
      // Every other transition leaves verifiedById/verifiedAt untouched —
      // the unified rule (docs/PHASE_30.3_DISCOVERY.md §15): they mean
      // "actor and time of the most recent VERIFY", a legacy display-only
      // field, never a live trust signal. The full per-action history lives
      // only in EvidenceStandingEvent below.
    } else {
      newState = stateTargetFor(action);
      updateData.state = newState;
    }

    const updatedEvidence = await tx.skillEvidence.update({
      where: { id: locked.id },
      data: updateData,
    });

    await tx.evidenceStandingEvent.create({
      data: {
        tenantId: actor.tenantId,
        userId: locked.userId,
        skillId: locked.skillId,
        evidenceId: locked.id,
        evidenceRevision: updatedEvidence.revision,
        action,
        actorId: actor.userId,
        actorRole: actor.role,
        actorName: actorRow?.name ?? null,
        reason: reason ?? null,
        previousVerificationStatus: locked.verificationStatus,
        newVerificationStatus,
        previousState: locked.state,
        newState,
        occurredAt: now,
      },
    });

    return projectUserSkill(tx, {
      tenantId: actor.tenantId,
      userId: locked.userId,
      skillId: locked.skillId,
      changeTimestamp: now,
      cause: PROFICIENCY_CAUSE_FOR_ACTION[action],
      evidenceId: locked.id,
      evidenceRevision: updatedEvidence.revision,
      actorId: actor.userId,
      actorRole: actor.role,
      reason,
    });
  });
}

export async function verifyEvidence(
  actor: AuthContext & { tenantId: string },
  evidenceId: string
): Promise<UserSkill> {
  return applyEvidenceTransition(actor, evidenceId, "VERIFY");
}

export async function rejectEvidence(
  actor: AuthContext & { tenantId: string },
  evidenceId: string
): Promise<UserSkill> {
  return applyEvidenceTransition(actor, evidenceId, "REJECT");
}

export async function unverifyEvidence(
  actor: AuthContext & { tenantId: string },
  evidenceId: string
): Promise<UserSkill> {
  return applyEvidenceTransition(actor, evidenceId, "UNVERIFY");
}

export async function reopenEvidence(
  actor: AuthContext & { tenantId: string },
  evidenceId: string
): Promise<UserSkill> {
  return applyEvidenceTransition(actor, evidenceId, "REOPEN");
}

export async function revokeEvidence(
  actor: AuthContext & { tenantId: string },
  evidenceId: string,
  reason: string
): Promise<UserSkill> {
  return applyEvidenceTransition(actor, evidenceId, "REVOKE", { reason });
}

export async function reinstateEvidence(
  actor: AuthContext & { tenantId: string },
  evidenceId: string,
  reason: string
): Promise<UserSkill> {
  return applyEvidenceTransition(actor, evidenceId, "REINSTATE", { reason });
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
