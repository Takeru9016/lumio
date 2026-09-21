import type { EnrollmentStatus, LearningAssignment } from "@/generated/prisma/client";
import type { AssignmentSource } from "@/generated/prisma/enums";
import { type AuthContext, requireRole, requireTenant } from "@/lib/auth/context";
import { db } from "@/lib/db";
import { computeCapabilityGap } from "@/lib/domain/capability/gaps";
import { canEnrollInCourse } from "@/lib/domain/course/enrollmentAccess";
import {
  assertCoursePrerequisitesMet,
  PrerequisitesNotMetError,
} from "@/lib/domain/course/prerequisites";
import {
  isValidDueDate,
  isValidId,
  isValidNote,
} from "@/lib/domain/learning-assignment/inputRules";
import {
  capabilityGapSourceKey,
  mandatorySourceKey,
  manualSourceKey,
} from "@/lib/domain/learning-assignment/sourceKeys";
import { deriveAssignmentStatus } from "@/lib/domain/learning-assignment/status";
import type {
  AssignmentOutcome,
  AssignmentReason,
  AssignmentSkipReason,
  CancelAssignmentResult,
  CapabilityGapAssignmentReason,
  CreateAssignmentResult,
  MandatoryAssignmentReason,
  ManualAssignmentReason,
} from "@/lib/domain/learning-assignment/types";
import { createNotification } from "@/lib/notifications";

export type Ctx = AuthContext & { tenantId: string };

// Only ORG_ADMIN writes assignments in V1. Instructors, students and super
// admins are all denied; a super admin is not a tenant actor.
export function authorizeActor(ctx: AuthContext): asserts ctx is Ctx {
  requireRole(ctx, ["ORG_ADMIN"]);
  requireTenant(ctx);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

type Learner = { id: string; clerkId: string; name: string | null };

type Course = {
  id: string;
  slug: string;
  title: string;
  tenantId: string | null;
};

type Provenance = {
  source: AssignmentSource;
  sourceKey: string;
  reason: AssignmentReason;
  mandatoryTrainingId: string | null;
};

type ProvenanceResult = Provenance | { skip: AssignmentSkipReason };

type AssignmentRequest = {
  userId: string;
  courseId: string;
  // undefined leaves an existing due date alone; null clears it.
  dueDate: Date | null | undefined;
  buildProvenance: (learner: Learner, course: Course) => Promise<ProvenanceResult>;
};

type TxResult = {
  outcome: AssignmentOutcome;
  assignment: LearningAssignment;
  enrollment: { id: string; status: EnrollmentStatus; created: boolean };
  hasLessonProgress: boolean;
};

// Thrown inside the transaction to abort it. Returning a skip value from the
// callback would COMMIT whatever had already been written (e.g. the
// enrollment), so every skip that can happen after a write rolls back instead.
class AssignmentRollback extends Error {
  constructor(
    public skip: AssignmentSkipReason,
    public prerequisites?: { courseId: string; slug: string; title: string }[]
  ) {
    super(skip);
    this.name = "AssignmentRollback";
  }
}

function sameDueDate(a: Date | null, b: Date | null): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

function formatDueDate(dueDate: Date): string {
  return dueDate.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * The single creation path behind every assignment source. The public entry
 * points below differ only in how they derive provenance; everything that
 * guards enrollment and tenant isolation lives here once:
 *
 *   actor (ORG_ADMIN, tenant from the session)
 *   -> learner (same tenant, active STUDENT, not deleted)
 *   -> course (canEnrollInCourse, PUBLISHED, free)
 *   -> source-specific provenance
 *   -> one transaction: prerequisite gate (only when no enrollment exists yet),
 *      then idempotent enrollment, then idempotent assignment
 *   -> best-effort, idempotent notification after the commit
 *
 * Idempotency is decided by the database, never by a read-then-write: both
 * inserts are INSERT ... ON CONFLICT DO NOTHING against their unique indexes,
 * so concurrent identical calls converge on one row of each.
 */
async function assignLearning(
  ctx: Ctx,
  request: AssignmentRequest
): Promise<CreateAssignmentResult> {
  const { userId, courseId, dueDate, buildProvenance } = request;

  // Checked once, here, for every source — including a due date that comes from
  // a MandatoryTraining row rather than from the caller. Runs before any read
  // or write so a value the database cannot store never reaches it.
  if (dueDate !== undefined && dueDate !== null && !isValidDueDate(dueDate)) {
    return { ok: false, reason: "INVALID_INPUT" };
  }

  // Unknown, cross-tenant, tenantless, deleted and non-student learners are
  // indistinguishable to the caller. ctx.tenantId is a string, so a learner
  // with a null tenant can never match.
  const learner = await db.user.findFirst({
    where: { id: userId, tenantId: ctx.tenantId, role: "STUDENT", deletedAt: null },
    select: { id: true, clerkId: true, name: true },
  });
  if (!learner) return { ok: false, reason: "LEARNER_NOT_ELIGIBLE" };

  const course = await db.course.findUnique({
    where: { id: courseId },
    select: { id: true, slug: true, title: true, tenantId: true, status: true, price: true },
  });
  // The same answer for a missing course and another tenant's course, so a
  // foreign course cannot be probed for.
  if (!course || !canEnrollInCourse(course.tenantId, ctx.tenantId)) {
    return { ok: false, reason: "COURSE_NOT_FOUND" };
  }
  // The open catalogue (no tenant) passes the tenant predicate, so it must not
  // be allowed to disclose more than "not assignable": the state and price of
  // a course the actor's tenant does not own are not the actor's to learn.
  // Only the actor's own tenant's courses get a specific reason.
  const ownsCourse = course.tenantId === ctx.tenantId;
  if (!ownsCourse && (course.status !== "PUBLISHED" || course.price > 0)) {
    return { ok: false, reason: "COURSE_NOT_FOUND" };
  }
  if (course.status !== "PUBLISHED") return { ok: false, reason: "COURSE_NOT_PUBLISHED" };
  // Assignment must never become a payment bypass: paid courses are out of
  // scope until org-paid licensing exists.
  if (course.price > 0) return { ok: false, reason: "COURSE_REQUIRES_PAYMENT" };

  const provenance = await buildProvenance(learner, course);
  if ("skip" in provenance) return { ok: false, reason: provenance.skip };

  const { source, sourceKey, reason, mandatoryTrainingId } = provenance;

  let txResult: TxResult;
  try {
    txResult = await db.$transaction(async (tx): Promise<TxResult> => {
      const existingEnrollment = await tx.enrollment.findUnique({
        where: { userId_courseId: { userId: learner.id, courseId: course.id } },
        select: { status: true },
      });
      // A refund revoked this learner's access. Assignment must not silently
      // restore it, and must not answer as if prerequisites were the problem.
      if (existingEnrollment?.status === "REFUNDED")
        throw new AssignmentRollback("ENROLLMENT_REFUNDED");

      // Prerequisites bind the creation of an enrollment, and only that: a learner
      // who already has one (ACTIVE or COMPLETED) keeps their access when a
      // prerequisite is added later. The gate runs before the enrollment write, so a
      // learner who has not met them never gets a row, not even an uncommitted one.
      // Concurrent calls each run it themselves and none reaches a write.
      if (existingEnrollment === null) {
        try {
          await assertCoursePrerequisitesMet(tx, { userId: learner.id, courseId: course.id });
        } catch (error) {
          if (error instanceof PrerequisitesNotMetError) {
            throw new AssignmentRollback("PREREQUISITES_NOT_MET", error.prerequisites);
          }
          throw error;
        }
      }

      const insertedEnrollment = await tx.enrollment.createMany({
        data: [{ userId: learner.id, courseId: course.id }],
        skipDuplicates: true,
      });
      const enrollment = await tx.enrollment.findUniqueOrThrow({
        where: { userId_courseId: { userId: learner.id, courseId: course.id } },
        select: { id: true, status: true },
      });
      // A refund that committed between the read above and the insert.
      if (enrollment.status === "REFUNDED") throw new AssignmentRollback("ENROLLMENT_REFUNDED");

      const insertedAssignment = await tx.learningAssignment.createMany({
        data: [
          {
            tenantId: ctx.tenantId,
            userId: learner.id,
            courseId: course.id,
            source,
            sourceKey,
            reason: reason as object,
            dueDate: dueDate ?? null,
            mandatoryTrainingId,
            assignedById: ctx.userId,
          },
        ],
        skipDuplicates: true,
      });

      const identity = {
        userId_courseId_source_sourceKey: {
          userId: learner.id,
          courseId: course.id,
          source,
          sourceKey,
        },
      };
      let assignment = await tx.learningAssignment.findUniqueOrThrow({ where: identity });

      // A row that already existed under another tenant (a learner who moved
      // tenant, on an open-catalogue course) is never adopted: the caller's
      // tenant alone controls which tenant an assignment belongs to.
      if (assignment.tenantId !== ctx.tenantId) throw new AssignmentRollback("ASSIGNMENT_CONFLICT");

      let outcome: AssignmentOutcome = "created";
      if (insertedAssignment.count === 0) {
        outcome = "existing";
        if (assignment.cancelledAt !== null) {
          // Reactivation keeps identity and the original provenance; only the
          // CURRENT cancellation state (and an explicitly supplied due date)
          // changes. The cancellation history (lastCancelled*, cancellationCount)
          // is deliberately left alone: it is what records that this happened.
          const reactivated = await tx.learningAssignment.updateMany({
            where: { id: assignment.id, cancelledAt: { not: null } },
            data: {
              cancelledAt: null,
              cancelledById: null,
              ...(dueDate !== undefined ? { dueDate } : {}),
            },
          });
          if (reactivated.count === 1) outcome = "reactivated";
        } else if (dueDate !== undefined && !sameDueDate(assignment.dueDate, dueDate)) {
          await tx.learningAssignment.update({ where: { id: assignment.id }, data: { dueDate } });
          outcome = "updated";
        }
        if (outcome !== "existing") {
          assignment = await tx.learningAssignment.findUniqueOrThrow({ where: identity });
        }
      }

      const progress = await tx.lessonProgress.findFirst({
        where: { userId: learner.id, lesson: { section: { courseId: course.id } } },
        select: { id: true },
      });

      return {
        outcome,
        assignment,
        enrollment: {
          id: enrollment.id,
          status: enrollment.status,
          created: insertedEnrollment.count === 1,
        },
        hasLessonProgress: progress !== null,
      };
    });
  } catch (error) {
    if (error instanceof AssignmentRollback) {
      return {
        ok: false,
        reason: error.skip,
        ...(error.prerequisites ? { prerequisites: error.prerequisites } : {}),
      };
    }
    throw error;
  }

  const { outcome, assignment, enrollment, hasLessonProgress } = txResult;

  const status = deriveAssignmentStatus({
    cancelledAt: assignment.cancelledAt,
    dueDate: assignment.dueDate,
    enrollmentStatus: enrollment.status,
    hasLessonProgress,
    now: new Date(),
  });

  // Nothing to do for a learner who has already completed the course, and a
  // reactivation never re-announces itself. Repeat calls do attempt the
  // notification: the dedupeKey makes that a no-op unless an earlier attempt
  // failed after the commit, in which case this heals it.
  let notificationCreated = false;
  if (outcome !== "reactivated" && status !== "COMPLETED") {
    try {
      const dueText = assignment.dueDate ? ` Due ${formatDueDate(assignment.dueDate)}.` : "";
      const result = await createNotification({
        userId: learner.id,
        tenantId: ctx.tenantId,
        type: "LEARNING_ASSIGNED",
        title: "New learning assigned",
        body: `You have been assigned "${course.title}".${dueText}`,
        link: `/courses/${course.slug}`,
        dedupeKey: `assignment:${assignment.id}:assigned`,
      });
      notificationCreated = result.created;
    } catch (error) {
      // A failed notification must never fail the assignment that triggered it.
      console.error(
        `[learning-assignment] Failed to create the assignment notification for assignment ${assignment.id}`,
        error
      );
    }
  }

  return { ok: true, outcome, assignment, status, enrollment, notificationCreated };
}

export type ManualAssignmentInput = {
  userId: string;
  courseId: string;
  dueDate?: Date | null;
  note?: string;
};

/**
 * ORG_ADMIN assigns a course to one learner. A learner has at most one manual
 * assignment per course; repeating the call is idempotent and re-assigning a
 * cancelled one reactivates it.
 *
 * Only the fields named in ManualAssignmentInput are ever read. `source`,
 * `sourceKey`, `reason` and `tenantId` are derived here and cannot be supplied.
 */
export async function createManualAssignment(
  ctx: AuthContext,
  input: ManualAssignmentInput
): Promise<CreateAssignmentResult> {
  authorizeActor(ctx);

  if (!isObject(input)) return { ok: false, reason: "INVALID_INPUT" };
  const { userId, courseId, dueDate } = input;
  if (!isValidId(userId) || !isValidId(courseId)) {
    return { ok: false, reason: "INVALID_INPUT" };
  }
  if (input.note !== undefined && input.note !== null && typeof input.note !== "string") {
    return { ok: false, reason: "INVALID_INPUT" };
  }
  const note = typeof input.note === "string" ? input.note.trim() : undefined;
  if (note !== undefined && !isValidNote(note)) {
    return { ok: false, reason: "INVALID_INPUT" };
  }

  return assignLearning(ctx, {
    userId,
    courseId,
    dueDate,
    buildProvenance: async () => {
      const actor = await db.user.findUnique({
        where: { id: ctx.userId },
        select: { name: true },
      });
      const reason: ManualAssignmentReason = {
        assignedById: ctx.userId,
        assignedByName: actor?.name ?? null,
        ...(note ? { note } : {}),
      };
      return {
        source: "MANUAL",
        sourceKey: manualSourceKey(courseId),
        reason,
        mandatoryTrainingId: null,
      };
    },
  });
}

export type MandatoryAssignmentInput = {
  userId: string;
  mandatoryTrainingId: string;
};

/**
 * Creates one learner's assignment from a MandatoryTraining policy. The
 * course and due date come from the policy, never from the caller, and the
 * learner must currently be a member of the policy's team so the recorded
 * provenance is true. Expansion across a whole team and team-membership hooks
 * are later slices; they call this per learner.
 */
export async function createMandatoryAssignment(
  ctx: AuthContext,
  input: MandatoryAssignmentInput
): Promise<CreateAssignmentResult> {
  authorizeActor(ctx);

  if (!isObject(input)) return { ok: false, reason: "INVALID_INPUT" };
  const { userId, mandatoryTrainingId } = input;
  if (!isValidId(userId) || !isValidId(mandatoryTrainingId)) {
    return { ok: false, reason: "INVALID_INPUT" };
  }

  const training = await db.mandatoryTraining.findFirst({
    where: { id: mandatoryTrainingId, tenantId: ctx.tenantId, team: { tenantId: ctx.tenantId } },
    select: {
      id: true,
      dueDate: true,
      courseId: true,
      teamId: true,
      team: { select: { name: true } },
    },
  });
  if (!training) return { ok: false, reason: "MANDATORY_TRAINING_NOT_FOUND" };

  return assignLearning(ctx, {
    userId,
    courseId: training.courseId,
    dueDate: training.dueDate,
    buildProvenance: async (learner, course) => {
      const membership = await db.teamMember.findUnique({
        where: { userId_teamId: { userId: learner.id, teamId: training.teamId } },
        select: { id: true },
      });
      if (!membership) return { skip: "LEARNER_NOT_IN_TEAM" };

      const reason: MandatoryAssignmentReason = {
        mandatoryTrainingId: training.id,
        teamId: training.teamId,
        teamName: training.team.name,
        courseId: course.id,
        courseTitle: course.title,
      };
      return {
        source: "MANDATORY",
        sourceKey: mandatorySourceKey(training.id),
        reason,
        mandatoryTrainingId: training.id,
      };
    },
  });
}

export type CapabilityGapAssignmentInput = {
  userId: string;
  roleId: string;
  skillId: string;
  courseId: string;
  dueDate?: Date | null;
};

/**
 * Creates an assignment that closes one capability gap. Nothing about the gap
 * is trusted from the caller: the learner must hold the role, the skill must
 * be a live requirement of that role and still unmet, and the course must be
 * one of the tenant's courses mapped to that skill. Required and current
 * proficiency are recomputed here through computeCapabilityGap, so the
 * provenance snapshot is always true at the time of assignment.
 */
export async function createCapabilityGapAssignment(
  ctx: AuthContext,
  input: CapabilityGapAssignmentInput
): Promise<CreateAssignmentResult> {
  authorizeActor(ctx);

  if (!isObject(input)) return { ok: false, reason: "INVALID_INPUT" };
  const { userId, roleId, skillId, courseId, dueDate } = input;
  if (!isValidId(userId) || !isValidId(roleId) || !isValidId(skillId) || !isValidId(courseId)) {
    return { ok: false, reason: "INVALID_INPUT" };
  }

  return assignLearning(ctx, {
    userId,
    courseId,
    dueDate,
    buildProvenance: async (learner, course) => {
      const held = await db.userJobRole.findFirst({
        where: { tenantId: ctx.tenantId, userId: learner.id, roleId },
        select: { id: true },
      });
      if (!held) return { skip: "GAP_NOT_FOUND" };

      const { role, gaps } = await computeCapabilityGap(
        { userId: learner.id, clerkId: learner.clerkId, tenantId: ctx.tenantId, role: "STUDENT" },
        roleId
      );
      const gap = gaps.find((g) => g.skillId === skillId);
      if (!role || !gap) return { skip: "GAP_NOT_FOUND" };
      if (gap.met) return { skip: "GAP_ALREADY_MET" };

      // Tenant-strict, unlike the enrollment predicate: a gap is closed by
      // one of this tenant's own courses, matching the recommendation engine.
      const mapping = await db.courseSkill.findFirst({
        where: {
          courseId: course.id,
          skillId,
          skill: { tenantId: ctx.tenantId, status: "ACTIVE" },
          course: { tenantId: ctx.tenantId },
        },
        select: { id: true },
      });
      if (!mapping) return { skip: "COURSE_DOES_NOT_ADDRESS_SKILL" };

      const reason: CapabilityGapAssignmentReason = {
        roleId: role.id,
        roleName: role.name,
        skillId: gap.skillId,
        skillName: gap.skillName,
        requiredProficiency: gap.requiredProficiency,
        currentProficiency: gap.currentProficiency,
        courseId: course.id,
        courseTitle: course.title,
      };
      return {
        source: "CAPABILITY_GAP",
        sourceKey: capabilityGapSourceKey(role.id, gap.skillId),
        reason,
        mandatoryTrainingId: null,
      };
    },
  });
}

/**
 * ORG_ADMIN cancels an assignment in their own tenant. The row is kept as
 * history; the learner stays enrolled and no progress, evidence or completion
 * is touched. A completed assignment cannot be cancelled.
 *
 * The learner's Enrollment row is locked for the duration, the same guard the
 * quiz attempt path uses. Course completion flips that row's status, so a
 * completion that races a cancellation either commits first (and this call
 * refuses) or waits until the cancellation is done.
 */
export async function cancelAssignment(
  ctx: AuthContext,
  assignmentId: string
): Promise<CancelAssignmentResult> {
  authorizeActor(ctx);

  if (!isValidId(assignmentId)) return { ok: false, reason: "ASSIGNMENT_NOT_FOUND" };

  return db.$transaction(async (tx): Promise<CancelAssignmentResult> => {
    const assignment = await tx.learningAssignment.findFirst({
      where: { id: assignmentId, tenantId: ctx.tenantId },
    });
    if (!assignment) return { ok: false, reason: "ASSIGNMENT_NOT_FOUND" };

    if (assignment.cancelledAt !== null) {
      return { ok: true, outcome: "already_cancelled", assignment };
    }

    const locked = await tx.$queryRaw<{ status: EnrollmentStatus }[]>`
      SELECT status FROM "Enrollment"
      WHERE "userId" = ${assignment.userId} AND "courseId" = ${assignment.courseId}
      FOR UPDATE`;
    if (locked[0]?.status === "COMPLETED") {
      return { ok: false, reason: "ASSIGNMENT_COMPLETED" };
    }

    // The history is written only by the call whose conditional update actually
    // flips the row (count === 1), in the same statement as the current state, so
    // a racing duplicate cancellation cannot record a second one. The actor's name
    // is snapshotted because cancelledById is cleared if that admin is deleted.
    const canceller = await tx.user.findUnique({
      where: { id: ctx.userId },
      select: { name: true },
    });
    const cancelledAt = new Date();
    const updated = await tx.learningAssignment.updateMany({
      where: { id: assignment.id, tenantId: ctx.tenantId, cancelledAt: null },
      data: {
        cancelledAt,
        cancelledById: ctx.userId,
        lastCancelledAt: cancelledAt,
        lastCancelledById: ctx.userId,
        lastCancelledByName: canceller?.name ?? null,
        cancellationCount: { increment: 1 },
      },
    });
    const current = await tx.learningAssignment.findUniqueOrThrow({
      where: { id: assignment.id },
    });
    return {
      ok: true,
      outcome: updated.count === 1 ? "cancelled" : "already_cancelled",
      assignment: current,
    };
  });
}
