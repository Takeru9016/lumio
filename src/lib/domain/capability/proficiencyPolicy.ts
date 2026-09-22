import type {
  EvidenceState,
  EvidenceType,
  EvidenceVerificationStatus,
  SkillProficiency,
} from "@/generated/prisma/client";
import { compareProficiency, maxProficiency } from "@/lib/domain/capability/proficiencyOrder";

/**
 * The V2 capability policy — Phase 30.1 foundation only
 * (docs/PHASE_30_CAPABILITY_PROFICIENCY_V2_CONTRACT.md §C/§D).
 *
 * Pure and deterministic: no Prisma import, no database read, no AI call, no
 * request/auth context. Every function here takes plain values and returns a
 * plain value — callers own fetching the rows and writing the result.
 *
 * This module implements Policy 1 only — the V1-compatible policy defined in
 * contract §C2, reproducing `src/lib/domain/capability/proficiency.ts`'s
 * existing `ceilingFor` exactly (verificationStatus-only, type-agnostic; no
 * ADVANCED/EXPERT; no score influence; no recency decay). It is NOT wired
 * into any runtime path yet — `proficiency.ts` remains the sole writer of
 * `UserSkill.proficiency` until Phase 30.2 completes reconciliation and
 * cutover (contract §H). Policy 2's type-aware grant table (§C3) — which
 * makes MANAGER_ASSESSMENT/CERTIFICATION evidence contribute, and is what
 * eventually raises `MAX_GRANTABLE_LEVEL` past INTERMEDIATE — is Phase
 * 30.3/30.8's addition, deliberately not built here.
 */

/** The current policy version this module implements. Not yet written anywhere. */
export const CURRENT_POLICY_VERSION = 1;

/** The three questions contract §B keeps separate — never conflated. */
export type EvidenceStanding = {
  verificationStatus: EvidenceVerificationStatus;
  state: EvidenceState;
  validUntil: Date | null;
};

/**
 * The level ONE evidence row grants, before validity is considered
 * (contract §C1/§C2). Ignores `type` — Policy 1 is deliberately type-agnostic,
 * matching V1's own `ceilingFor` (proficiency.ts) exactly: VERIFIED grants
 * INTERMEDIATE, any other non-rejected status grants BEGINNER. REJECTED
 * evidence never reaches `isEvidenceValid`'s caller in practice, but is
 * handled explicitly here rather than assumed unreachable, the same
 * discipline V1's own PENDING handling already uses.
 */
export function ceilingFor(
  evidence: Pick<EvidenceStanding, "verificationStatus">
): SkillProficiency {
  if (evidence.verificationStatus === "REJECTED") return "NONE";
  if (evidence.verificationStatus === "VERIFIED") return "INTERMEDIATE";
  return "BEGINNER";
}

/**
 * `valid(e, asOf)` (contract §B2): ACTIVE, not REJECTED, not expired as of
 * `asOf`. The fourth B2 clause — the evidence's tenant matching the user's
 * and skill's — is deliberately NOT checked here: `EvidenceStanding` is a
 * pure, DB-free type with no tenant fields, so that check belongs to the
 * caller's query scope, exactly the posture V1's own `ceilingFor` query
 * already takes (every capability query is written pre-scoped to one
 * tenant; this module does not re-verify it).
 */
export function isEvidenceValid(evidence: EvidenceStanding, asOf: Date): boolean {
  if (evidence.state !== "ACTIVE") return false;
  if (evidence.verificationStatus === "REJECTED") return false;
  if (evidence.validUntil !== null && evidence.validUntil <= asOf) return false;
  return true;
}

/**
 * `contributes(e, asOf)` (contract §B3): valid AND grants above NONE. Under
 * Policy 1 this is always equal to `isEvidenceValid` — the only way
 * `ceilingFor` returns NONE is REJECTED, which `isEvidenceValid` already
 * excludes — so the two predicates coincide for every evidence type Policy 1
 * knows about. They are still computed as two separate steps, not collapsed
 * into one function, because Policy 2 (30.3) makes them diverge: a reserved
 * type (PROJECT/ASSIGNMENT/MANUAL/AI_EVALUATION) can be ACTIVE and VERIFIED
 * — valid — while still granting NONE, so "valid" and "contributes" must
 * stay independently checkable now, not merged while they happen to agree.
 */
export function doesEvidenceContribute(evidence: EvidenceStanding, asOf: Date): boolean {
  return isEvidenceValid(evidence, asOf) && ceilingFor(evidence) !== "NONE";
}

/**
 * The level a learner's evidence set projects to (the pure core of what
 * `proficiency.ts`'s `projectUserSkill` does against the database). Order-
 * independent by construction (folds through `maxProficiency`), matching
 * V1's own guarantee. Not called by any runtime path in 30.1 — Phase 30.2
 * is what wires a DB read into this function and a locked write back out.
 */
export function projectProficiency(
  evidence: readonly EvidenceStanding[],
  asOf: Date
): SkillProficiency {
  return maxProficiency(
    evidence.filter((e) => doesEvidenceContribute(e, asOf)).map((e) => ceilingFor(e))
  );
}

/** What `confidenceFor` needs per evidence row: standing plus what corroboration and freshness require. */
export type ConfidenceInput = EvidenceStanding & {
  type: EvidenceType;
  occurredAt: Date | null;
};

/** Contract §D5 — a code constant, not tenant-configurable. */
export const CONFIDENCE_FRESHNESS_WINDOW_DAYS = 365;
const FRESHNESS_WINDOW_MS = CONFIDENCE_FRESHNESS_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * `fresh(e)` (contract §D2): an explicit `validUntil` in the future, or
 * (absent one) within the freshness window of `occurredAt`. An evidence row
 * with no known `occurredAt` (every row until Phase 30.2's backfill) cannot
 * be asserted fresh — this is a deliberate "unknown is not fresh" default,
 * not an oversight; it is exactly why `confidenceFor` returns LOW rather
 * than HIGH for the un-backfilled evidence Phase 30.1 leaves behind.
 */
function isFresh(
  evidence: Pick<ConfidenceInput, "occurredAt" | "validUntil">,
  asOf: Date
): boolean {
  if (evidence.validUntil !== null) return evidence.validUntil > asOf;
  if (evidence.occurredAt === null) return false;
  return asOf.getTime() - evidence.occurredAt.getTime() <= FRESHNESS_WINDOW_MS;
}

/**
 * Derived confidence for a projected `level` (contract §D1/§D2): never an
 * input to the level, never settable by a request — a pure read of the
 * evidence that supports the level already computed. `validEvidence` should
 * be the caller's already-`isEvidenceValid`-filtered set (this function does
 * not re-check validity, only supports/freshness/corroboration among it);
 * "supporting" is computed internally as the subset whose `ceilingFor`
 * equals `level`, per contract §D2's own definition, rather than trusted
 * from the caller.
 *
 * Under Policy 1 there is no assessed-level evidence, so "VERIFIED-or-
 * assessed" (the contract's phrasing) reduces to "VERIFIED" here; Phase
 * 30.8 is what introduces the assessed case.
 *
 * Returns null when `level` is NONE (there is nothing to have confidence
 * about) or when no valid evidence actually supports it (a level asserted
 * with no matching evidence — not expected under Policy 1's own
 * `projectProficiency`, but handled rather than assumed impossible).
 */
export function confidenceFor(
  level: SkillProficiency,
  validEvidence: readonly ConfidenceInput[],
  asOf: Date
): EvidenceConfidenceResult {
  if (level === "NONE") return null;

  const supporting = validEvidence.filter((e) => ceilingFor(e) === level);
  if (supporting.length === 0) return null;

  if (supporting.some((e) => e.verificationStatus === "VERIFIED" && isFresh(e, asOf))) {
    return "HIGH";
  }

  const hasStaleVerified = supporting.some((e) => e.verificationStatus === "VERIFIED");
  const distinctUnverifiedTypes = new Set(
    supporting.filter((e) => e.verificationStatus !== "VERIFIED").map((e) => e.type)
  ).size;
  if (hasStaleVerified || distinctUnverifiedTypes >= 2) return "MEDIUM";

  return "LOW";
}

// Kept as a local alias so the exported signature above stays readable
// without importing the generated enum type just for this one return
// position — see EvidenceConfidence in schema.prisma.
type EvidenceConfidenceResult = "LOW" | "MEDIUM" | "HIGH" | null;

/**
 * The highest `SkillProficiency` the current policy's `ceilingFor` can ever
 * grant — derived by actually evaluating `ceilingFor` over every reachable
 * verification status, never a hard-coded level name. This is what makes
 * `isAssessable` below correct by construction rather than by convention: it
 * updates itself the moment `ceilingFor`'s policy changes (Phase 30.3/30.8),
 * with no second place to remember to edit.
 */
export const MAX_GRANTABLE_LEVEL: SkillProficiency = maxProficiency(
  (["UNVERIFIED", "VERIFIED"] as const).map((verificationStatus) =>
    ceilingFor({ verificationStatus })
  )
);

/**
 * Can the current policy ever produce `requiredProficiency` for anyone
 * (contract §8/§19, pre-flight audit §8's "smallest safe early guard")?
 * Deliberately expressed only in terms of `MAX_GRANTABLE_LEVEL` — never as
 * `requiredProficiency === "ADVANCED"` or `< "ADVANCED"` — so it needs no
 * edit when the policy's reachable ceiling changes.
 */
export function isAssessable(requiredProficiency: SkillProficiency): boolean {
  return compareProficiency(requiredProficiency, MAX_GRANTABLE_LEVEL) <= 0;
}
