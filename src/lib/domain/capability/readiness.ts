import type { SkillProficiency } from "@/generated/prisma/client";
import { isAtLeast, PROFICIENCY_ORDER } from "@/lib/domain/capability/proficiencyOrder";
import { isAssessable } from "@/lib/domain/capability/proficiencyPolicy";

/**
 * The canonical readiness evaluator — Phase 30.1 foundation only
 * (docs/PHASE_30_CAPABILITY_PROFICIENCY_V2_CONTRACT.md §G).
 *
 * Pure: no Prisma, no request context. `gaps.ts`, `organizationReport.ts`
 * and `instructorReport.ts` (two call sites) each still compute
 * `met`/`compareProficiency` inline, unchanged — this module is not yet
 * wired into any of them (contract §G1 calls for that migration; this phase
 * only establishes the evaluator and proves it agrees with all four). Doing
 * that migration now was considered and rejected for 30.1: it would touch
 * four production read paths for no behavior change, which is exactly the
 * kind of "unless necessary to prevent duplicated semantics" the phase
 * brief warns against forcing prematurely.
 *
 * Placement note: the pre-flight audit (§8/§11/§24) suggested
 * `proficiencyOrder.ts` as the evaluator's home, reasoning that every
 * existing readiness call site already imports comparison primitives from
 * there. That reasoning predates `proficiencyPolicy.ts` (this phase): the
 * evaluator needs `isAssessable`, which lives in the policy module, and
 * `proficiencyPolicy.ts` already imports `proficiencyOrder.ts` for
 * `compareProficiency`/`maxProficiency` — putting the evaluator inside
 * `proficiencyOrder.ts` too would make it import back from
 * `proficiencyPolicy.ts`, a cycle. A third, dedicated file avoids that
 * without giving `proficiencyOrder.ts` a policy dependency it doesn't
 * otherwise need. Documented here as a deviation from the audit's specific
 * file suggestion, not from its underlying architecture.
 */

export type RequirementStatus = "MET" | "BELOW" | "MISSING" | "NOT_ASSESSABLE";

export type RequirementReadiness = {
  requiredProficiency: SkillProficiency;
  currentProficiency: SkillProficiency;
  status: RequirementStatus;
  /** Ordinal levels still needed to reach `requiredProficiency`. 0 for MET and NOT_ASSESSABLE. */
  levelsShort: number;
};

/**
 * One requirement's readiness (contract §G2). `MET` is checked first and
 * unconditionally — a learner who already demonstrably meets a requirement
 * is MET regardless of whether that level is generally assessable for
 * everyone else, which also makes this function self-consistent: under any
 * policy, `current >= required` already implies `required` was reachable by
 * someone. `NOT_ASSESSABLE` is evaluated only once MET is ruled out, and is
 * derived from the policy's own ceiling (`isAssessable`), never from a
 * hard-coded level name — see `proficiencyPolicy.ts`.
 *
 * No role-level verdict is computed here (no `{ready, met, total}`) — the
 * contract's §G4 aggregate is deliberately deferred past 30.1.
 */
export function evaluateRequirement(
  requiredProficiency: SkillProficiency,
  currentProficiency: SkillProficiency
): RequirementReadiness {
  if (isAtLeast(currentProficiency, requiredProficiency)) {
    return { requiredProficiency, currentProficiency, status: "MET", levelsShort: 0 };
  }

  if (!isAssessable(requiredProficiency)) {
    return { requiredProficiency, currentProficiency, status: "NOT_ASSESSABLE", levelsShort: 0 };
  }

  const status: RequirementStatus = currentProficiency === "NONE" ? "MISSING" : "BELOW";
  const levelsShort =
    PROFICIENCY_ORDER.indexOf(requiredProficiency) - PROFICIENCY_ORDER.indexOf(currentProficiency);
  return { requiredProficiency, currentProficiency, status, levelsShort };
}
