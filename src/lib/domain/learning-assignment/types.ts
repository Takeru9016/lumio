import type {
  EnrollmentStatus,
  LearningAssignment,
  SkillProficiency,
} from "@/generated/prisma/client";
import type { AssignmentStatus } from "@/lib/domain/learning-assignment/status";

/**
 * Immutable provenance snapshots, written once when an assignment is created
 * and never updated — not on repeat creation, and not on reactivation. They
 * answer "why did I get this learning?" and are always computed by the
 * service, never accepted from a client.
 */
export type ManualAssignmentReason = {
  assignedById: string;
  assignedByName: string | null;
  note?: string;
};

export type MandatoryAssignmentReason = {
  mandatoryTrainingId: string;
  teamId: string;
  teamName: string;
  courseId: string;
  courseTitle: string;
};

export type CapabilityGapAssignmentReason = {
  roleId: string;
  roleName: string;
  skillId: string;
  skillName: string;
  requiredProficiency: SkillProficiency;
  currentProficiency: SkillProficiency;
  courseId: string;
  courseTitle: string;
};

export type AssignmentReason =
  | ManualAssignmentReason
  | MandatoryAssignmentReason
  | CapabilityGapAssignmentReason;

/**
 * Why an assignment was not created. Deliberately coarse for anything that
 * could reveal data outside the actor's tenant: an unknown learner, a learner
 * in another tenant and a learner who is not an active student all report
 * LEARNER_NOT_ELIGIBLE; a missing course and another tenant's course both
 * report COURSE_NOT_FOUND.
 */
export type AssignmentSkipReason =
  | "INVALID_INPUT"
  | "LEARNER_NOT_ELIGIBLE"
  | "COURSE_NOT_FOUND"
  | "COURSE_NOT_PUBLISHED"
  | "COURSE_REQUIRES_PAYMENT"
  | "ENROLLMENT_REFUNDED"
  | "ASSIGNMENT_CONFLICT"
  | "MANDATORY_TRAINING_NOT_FOUND"
  | "LEARNER_NOT_IN_TEAM"
  | "GAP_NOT_FOUND"
  | "GAP_ALREADY_MET"
  // Phase 30 G1 guard: the gap's required proficiency is above what the
  // current capability policy can ever grant anyone — see
  // src/lib/domain/capability/proficiencyPolicy.ts's isAssessable.
  | "GAP_NOT_ASSESSABLE"
  | "COURSE_DOES_NOT_ADDRESS_SKILL"
  // The learner has not completed every enforceable prerequisite of the course
  // and has no enrollment yet (Phase 29.2). No enrollment or assignment is created.
  | "PREREQUISITES_NOT_MET";

export type AssignmentOutcome =
  // A new assignment row was inserted.
  | "created"
  // A cancelled row was reactivated (provenance and identity preserved).
  | "reactivated"
  // An active row already existed and only its due date changed.
  | "updated"
  // An active row already existed; nothing changed.
  | "existing";

export type CreateAssignmentResult =
  | {
      ok: true;
      outcome: AssignmentOutcome;
      assignment: LearningAssignment;
      status: AssignmentStatus;
      enrollment: { id: string; status: EnrollmentStatus; created: boolean };
      // True only when this call inserted the LEARNING_ASSIGNED notification;
      // the signal a later email layer keys off. False when the notification
      // already existed, was not applicable (completed learner, reactivation)
      // or failed to insert.
      notificationCreated: boolean;
    }
  | {
      ok: false;
      reason: AssignmentSkipReason;
      // Only for PREREQUISITES_NOT_MET: the prerequisites that remain.
      prerequisites?: { courseId: string; slug: string; title: string }[];
    };

export type CancelAssignmentResult =
  | {
      ok: true;
      outcome: "cancelled" | "already_cancelled";
      assignment: LearningAssignment;
    }
  | { ok: false; reason: "ASSIGNMENT_NOT_FOUND" | "ASSIGNMENT_COMPLETED" };
