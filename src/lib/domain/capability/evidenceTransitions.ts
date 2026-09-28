import type {
  EvidenceState,
  EvidenceVerificationStatus,
  ProficiencyEventCause,
  Role,
} from "@/generated/prisma/client";

/**
 * Phase 30.3 — the pure evidence-standing state machine
 * (docs/PHASE_30.3_DISCOVERY.md §3/§15/§24, contract §Q's "Amends E1").
 *
 * Pure and deterministic: no Prisma, no request context, no I/O. `verification.ts`
 * calls this to decide legality and authorization BEFORE touching the
 * database; the lock/write sequence itself lives there (docs/PHASE_30.3_DISCOVERY.md
 * §14/§34 D21 — this module answers "is it legal", not "how do we make it happen
 * safely under concurrency").
 *
 * Two independent axes, never merged (discovery §2/§13):
 *   - verification axis: VERIFY, REJECT, UNVERIFY, REOPEN — transition
 *     `EvidenceVerificationStatus`, always require `state === ACTIVE` first.
 *   - state axis: REVOKE, REINSTATE — transition `EvidenceState`, never
 *     require source resolution (discovery §25's per-action table).
 */

export type VerificationAxisAction = "VERIFY" | "REJECT" | "UNVERIFY" | "REOPEN";
export type StateAxisAction = "REVOKE" | "REINSTATE";
export type EvidenceTransitionAction = VerificationAxisAction | StateAxisAction;

export type TransitionEvaluation =
  | { outcome: "no-op" }
  | { outcome: "apply" }
  | { outcome: "refuse"; code: "NOT_ACTIVE" | "ILLEGAL_TRANSITION" };

const VERIFICATION_AXIS: Record<
  VerificationAxisAction,
  { source: EvidenceVerificationStatus[]; target: EvidenceVerificationStatus }
> = {
  VERIFY: { source: ["UNVERIFIED", "PENDING", "REJECTED"], target: "VERIFIED" },
  REJECT: { source: ["UNVERIFIED", "PENDING", "VERIFIED"], target: "REJECTED" },
  UNVERIFY: { source: ["VERIFIED"], target: "UNVERIFIED" },
  REOPEN: { source: ["REJECTED"], target: "UNVERIFIED" },
};

const STATE_AXIS: Record<StateAxisAction, { source: EvidenceState[]; target: EvidenceState }> = {
  REVOKE: { source: ["ACTIVE"], target: "REVOKED" },
  REINSTATE: { source: ["REVOKED"], target: "ACTIVE" },
};

export function isVerificationAxisAction(
  action: EvidenceTransitionAction
): action is VerificationAxisAction {
  return action === "VERIFY" || action === "REJECT" || action === "UNVERIFY" || action === "REOPEN";
}

export function isStateAxisAction(action: EvidenceTransitionAction): action is StateAxisAction {
  return action === "REVOKE" || action === "REINSTATE";
}

/**
 * Evaluates ONE evidence-standing action against the row's CURRENT standing
 * (docs/PHASE_30.3_DISCOVERY.md §15's general precondition rule). Order,
 * exactly as specified — a verification-axis action refuses on a non-ACTIVE
 * row BEFORE the no-op check runs, so a VERIFIED-but-REVOKED row's `verify`
 * is never silently treated as a no-op just because `verificationStatus`
 * already reads VERIFIED underneath (discovery §15, the ordering fix):
 *
 *   1. verification-axis action AND state != ACTIVE -> refuse NOT_ACTIVE
 *   2. current already equals the action's target    -> no-op
 *   3. current is in the action's legal source set    -> apply
 *   4. otherwise                                       -> refuse ILLEGAL_TRANSITION
 */
export function evaluateTransition(
  action: EvidenceTransitionAction,
  current: { verificationStatus: EvidenceVerificationStatus; state: EvidenceState }
): TransitionEvaluation {
  if (isVerificationAxisAction(action)) {
    if (current.state !== "ACTIVE") return { outcome: "refuse", code: "NOT_ACTIVE" };
    const def = VERIFICATION_AXIS[action];
    if (current.verificationStatus === def.target) return { outcome: "no-op" };
    if (def.source.includes(current.verificationStatus)) return { outcome: "apply" };
    return { outcome: "refuse", code: "ILLEGAL_TRANSITION" };
  }
  const def = STATE_AXIS[action];
  if (current.state === def.target) return { outcome: "no-op" };
  if (def.source.includes(current.state)) return { outcome: "apply" };
  return { outcome: "refuse", code: "ILLEGAL_TRANSITION" };
}

/** The verification-axis target status for an action; only defined for that axis. */
export function verificationTargetFor(action: VerificationAxisAction): EvidenceVerificationStatus {
  return VERIFICATION_AXIS[action].target;
}

/** The state-axis target state for an action; only defined for that axis. */
export function stateTargetFor(action: StateAxisAction): EvidenceState {
  return STATE_AXIS[action].target;
}

/**
 * Which roles are even candidates for this action (docs/PHASE_30.3_DISCOVERY.md
 * §24) — a necessary but not sufficient condition. `VERIFY`/`REOPEN` still
 * additionally require course ownership for INSTRUCTOR (checked in
 * `verification.ts`, needs the resolved source, not pure). `REJECT`/`UNVERIFY`
 * grant ORG_ADMIN authority the raising actions (`VERIFY`/`REOPEN`) do not —
 * contract D3, "ORG_ADMIN may lower, never verify."
 */
export function roleMayAttempt(action: EvidenceTransitionAction, role: Role): boolean {
  switch (action) {
    case "VERIFY":
    case "REOPEN":
      return role === "INSTRUCTOR" || role === "SUPER_ADMIN";
    case "REJECT":
    case "UNVERIFY":
      return role === "INSTRUCTOR" || role === "SUPER_ADMIN" || role === "ORG_ADMIN";
    case "REVOKE":
    case "REINSTATE":
      return role === "ORG_ADMIN" || role === "SUPER_ADMIN";
    default:
      return false;
  }
}

/**
 * Whether this action requires the evidence's source to resolve to a course
 * before it may proceed (docs/PHASE_30.3_DISCOVERY.md §25's per-action
 * table, superseding contract E4's blanket claim). Every verification-axis
 * action keeps V1's locked fail-closed rule unchanged; only the two new
 * state-axis actions (REVOKE/REINSTATE) depart from it, because their whole
 * purpose is correcting evidence exactly when the source is unresolvable.
 */
export function requiresSourceResolution(action: EvidenceTransitionAction): boolean {
  return isVerificationAxisAction(action);
}

/** Every action's mapped `SkillProficiencyEvent.cause` (contract §F7, all already declared in 30.1). */
export const PROFICIENCY_CAUSE_FOR_ACTION: Record<EvidenceTransitionAction, ProficiencyEventCause> =
  {
    VERIFY: "EVIDENCE_VERIFIED",
    REJECT: "EVIDENCE_REJECTED",
    UNVERIFY: "VERIFICATION_REVOKED",
    REOPEN: "EVIDENCE_REOPENED",
    REVOKE: "EVIDENCE_REVOKED",
    REINSTATE: "EVIDENCE_REINSTATED",
  };

/** Actions whose `EvidenceStandingEvent.reason` is required, not optional (discovery §13). */
export function reasonRequired(action: EvidenceTransitionAction): boolean {
  return action === "REVOKE" || action === "REINSTATE";
}
