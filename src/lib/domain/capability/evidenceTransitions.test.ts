import { describe, expect, it } from "vitest";
import type { EvidenceState, EvidenceVerificationStatus, Role } from "@/generated/prisma/client";
import {
  type EvidenceTransitionAction,
  evaluateTransition,
  isStateAxisAction,
  isVerificationAxisAction,
  PROFICIENCY_CAUSE_FOR_ACTION,
  reasonRequired,
  requiresSourceResolution,
  roleMayAttempt,
  stateTargetFor,
  verificationTargetFor,
} from "@/lib/domain/capability/evidenceTransitions";

const ACTIONS: EvidenceTransitionAction[] = [
  "VERIFY",
  "REJECT",
  "UNVERIFY",
  "REOPEN",
  "REVOKE",
  "REINSTATE",
];
const STATUSES: EvidenceVerificationStatus[] = ["UNVERIFIED", "PENDING", "VERIFIED", "REJECTED"];
const STATES: EvidenceState[] = ["ACTIVE", "SUPERSEDED", "EXPIRED", "REVOKED"];
const ROLES: Role[] = ["STUDENT", "INSTRUCTOR", "ORG_ADMIN", "SUPER_ADMIN"];

describe("evaluateTransition — exhaustive over every (action, verificationStatus, state) combination", () => {
  for (const action of ACTIONS) {
    for (const state of STATES) {
      for (const status of STATUSES) {
        it(`${action} from (status=${status}, state=${state})`, () => {
          const result = evaluateTransition(action, { verificationStatus: status, state });

          if (isVerificationAxisAction(action)) {
            if (state !== "ACTIVE") {
              expect(result).toEqual({ outcome: "refuse", code: "NOT_ACTIVE" });
              return;
            }
            const target = verificationTargetFor(action);
            if (status === target) {
              expect(result).toEqual({ outcome: "no-op" });
              return;
            }
            const legalSource: Record<typeof action, EvidenceVerificationStatus[]> = {
              VERIFY: ["UNVERIFIED", "PENDING", "REJECTED"],
              REJECT: ["UNVERIFIED", "PENDING", "VERIFIED"],
              UNVERIFY: ["VERIFIED"],
              REOPEN: ["REJECTED"],
            } as Record<typeof action, EvidenceVerificationStatus[]>;
            if (legalSource[action].includes(status)) {
              expect(result).toEqual({ outcome: "apply" });
            } else {
              expect(result).toEqual({ outcome: "refuse", code: "ILLEGAL_TRANSITION" });
            }
          } else {
            // state-axis: verificationStatus is irrelevant to the decision
            const target = stateTargetFor(action);
            if (state === target) {
              expect(result).toEqual({ outcome: "no-op" });
              return;
            }
            const legalSource: Record<typeof action, EvidenceState[]> = {
              REVOKE: ["ACTIVE"],
              REINSTATE: ["REVOKED"],
            } as Record<typeof action, EvidenceState[]>;
            if (legalSource[action].includes(state)) {
              expect(result).toEqual({ outcome: "apply" });
            } else {
              expect(result).toEqual({ outcome: "refuse", code: "ILLEGAL_TRANSITION" });
            }
          }
        });
      }
    }
  }
});

describe("evaluateTransition — the ordering fix (docs/PHASE_30.3_DISCOVERY.md §15): NOT_ACTIVE beats no-op", () => {
  it("a VERIFIED-but-REVOKED row's verify is refused as NOT_ACTIVE, never treated as a no-op", () => {
    const result = evaluateTransition("VERIFY", {
      verificationStatus: "VERIFIED",
      state: "REVOKED",
    });
    expect(result).toEqual({ outcome: "refuse", code: "NOT_ACTIVE" });
  });

  it("a REJECTED-but-EXPIRED row's reject is refused as NOT_ACTIVE, never a no-op", () => {
    const result = evaluateTransition("REJECT", {
      verificationStatus: "REJECTED",
      state: "EXPIRED",
    });
    expect(result).toEqual({ outcome: "refuse", code: "NOT_ACTIVE" });
  });
});

describe("roleMayAttempt — exhaustive over every (action, role)", () => {
  const expected: Record<EvidenceTransitionAction, Role[]> = {
    VERIFY: ["INSTRUCTOR", "SUPER_ADMIN"],
    REOPEN: ["INSTRUCTOR", "SUPER_ADMIN"],
    REJECT: ["INSTRUCTOR", "SUPER_ADMIN", "ORG_ADMIN"],
    UNVERIFY: ["INSTRUCTOR", "SUPER_ADMIN", "ORG_ADMIN"],
    REVOKE: ["ORG_ADMIN", "SUPER_ADMIN"],
    REINSTATE: ["ORG_ADMIN", "SUPER_ADMIN"],
  };

  for (const action of ACTIONS) {
    for (const role of ROLES) {
      it(`${action} x ${role}`, () => {
        expect(roleMayAttempt(action, role)).toBe(expected[action].includes(role));
      });
    }
  }

  it("STUDENT may never attempt any evidence-standing action (independence rule)", () => {
    for (const action of ACTIONS) {
      expect(roleMayAttempt(action, "STUDENT")).toBe(false);
    }
  });

  it("ORG_ADMIN may lower (reject/unverify/revoke/reinstate) but never verify or reopen — contract D3", () => {
    expect(roleMayAttempt("VERIFY", "ORG_ADMIN")).toBe(false);
    expect(roleMayAttempt("REOPEN", "ORG_ADMIN")).toBe(false);
    expect(roleMayAttempt("REJECT", "ORG_ADMIN")).toBe(true);
    expect(roleMayAttempt("UNVERIFY", "ORG_ADMIN")).toBe(true);
    expect(roleMayAttempt("REVOKE", "ORG_ADMIN")).toBe(true);
    expect(roleMayAttempt("REINSTATE", "ORG_ADMIN")).toBe(true);
  });

  it("INSTRUCTOR may never revoke or reinstate — those are administrative-only", () => {
    expect(roleMayAttempt("REVOKE", "INSTRUCTOR")).toBe(false);
    expect(roleMayAttempt("REINSTATE", "INSTRUCTOR")).toBe(false);
  });
});

describe("requiresSourceResolution — per-action table (docs/PHASE_30.3_DISCOVERY.md §25, supersedes contract E4)", () => {
  it("every verification-axis action requires source resolution", () => {
    expect(requiresSourceResolution("VERIFY")).toBe(true);
    expect(requiresSourceResolution("REJECT")).toBe(true);
    expect(requiresSourceResolution("UNVERIFY")).toBe(true);
    expect(requiresSourceResolution("REOPEN")).toBe(true);
  });

  it("state-axis actions never require source resolution", () => {
    expect(requiresSourceResolution("REVOKE")).toBe(false);
    expect(requiresSourceResolution("REINSTATE")).toBe(false);
  });
});

describe("isVerificationAxisAction / isStateAxisAction — the two axes partition all six actions", () => {
  it("every action is exactly one axis, never both, never neither", () => {
    for (const action of ACTIONS) {
      expect(isVerificationAxisAction(action) !== isStateAxisAction(action)).toBe(true);
    }
  });
});

describe("PROFICIENCY_CAUSE_FOR_ACTION — every action maps to a declared ProficiencyEventCause (contract §F7)", () => {
  it("covers all six actions with distinct causes", () => {
    const causes = ACTIONS.map((a) => PROFICIENCY_CAUSE_FOR_ACTION[a]);
    expect(new Set(causes).size).toBe(6);
    expect(PROFICIENCY_CAUSE_FOR_ACTION.VERIFY).toBe("EVIDENCE_VERIFIED");
    expect(PROFICIENCY_CAUSE_FOR_ACTION.REJECT).toBe("EVIDENCE_REJECTED");
    expect(PROFICIENCY_CAUSE_FOR_ACTION.UNVERIFY).toBe("VERIFICATION_REVOKED");
    expect(PROFICIENCY_CAUSE_FOR_ACTION.REOPEN).toBe("EVIDENCE_REOPENED");
    expect(PROFICIENCY_CAUSE_FOR_ACTION.REVOKE).toBe("EVIDENCE_REVOKED");
    expect(PROFICIENCY_CAUSE_FOR_ACTION.REINSTATE).toBe("EVIDENCE_REINSTATED");
  });
});

describe("reasonRequired", () => {
  it("only REVOKE and REINSTATE require a reason", () => {
    for (const action of ACTIONS) {
      expect(reasonRequired(action)).toBe(action === "REVOKE" || action === "REINSTATE");
    }
  });
});
