import type { SkillProficiency } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { maxProficiency } from "@/lib/domain/capability/proficiencyOrder";
import {
  ceilingFor,
  doesEvidenceContribute,
  MAX_GRANTABLE_LEVEL,
} from "@/lib/domain/capability/proficiencyPolicy";

/**
 * Phase 30.2 — the V1-vs-Policy-1 reconciliation proof (contract §H3/§H6,
 * task §16/§17). Read-only by construction: it never calls `projectUserSkill`
 * (the one writer, `proficiency.ts`) — this is the "shadow computation" step
 * of the cutover sequence (task §18 step 3), which must run BEFORE anything
 * writes. It shares the LEVEL-COMPUTATION policy (`proficiencyPolicy.ts`)
 * with the writer — the same `ceilingFor`/`doesEvidenceContribute`/
 * `maxProficiency` — without sharing the write path, which would violate
 * "read-only."
 *
 * Classification is a strict priority order, each step using a
 * DETERMINABLE marker rather than an assumption (task §17: "identify
 * fixture-originated states where determinable"):
 *
 *   1. EXPLAINABLE_LEGACY — the stored level is above what Policy 1 (or V1,
 *      identical ceiling) can ever grant (ADVANCED/EXPERT). No writer in this
 *      codebase has ever produced that value from evidence (contract C6);
 *      it can only be a direct `db.userSkill.create`/test fixture or a
 *      manual DB edit.
 *   2. EXACT_MATCH — stored equals the fresh Policy 1 computation.
 *   3. FIXTURE_ONLY — stored differs, and either of two determinable markers
 *      shows no real writer ever produced this row:
 *        a) zero CONTRIBUTING SkillEvidence rows exist (contract §B3 —
 *           covers both no evidence at all, and evidence that exists but is
 *           entirely REJECTED/invalid; V1's own query excludes REJECTED the
 *           same way Policy 1's `doesEvidenceContribute` does, so neither
 *           policy's writer could ever produce non-NONE from zero
 *           contributing rows). First run against this repo's accumulated
 *           test database (docs/PHASE_30.2_RECONCILIATION.json) found this
 *           shape 270 times: one REJECTED evidence row paired with a
 *           UserSkill fixture set to BEGINNER directly.
 *        b) `lastAssessedAt IS NULL` — every real writer (V1's original
 *           `projectUserSkill` and this phase's canonical recompute alike)
 *           unconditionally sets `lastAssessedAt` the first time it creates
 *           a `UserSkill` row (contract §F3 — "set on first creation").
 *           A row with `lastAssessedAt` still null was therefore created
 *           directly (`db.userSkill.create`, a fixture), never through any
 *           writer — regardless of what evidence happens to exist alongside
 *           it. Found 3 times in the same run, the mirror-image shape
 *           (contributing evidence present, but the stored row itself was
 *           never recomputed).
 *      Both (a) and (b) are widenings made AFTER seeing this repo's real
 *      first run surface each shape — not designed in from a guess.
 *   4. UNEXPLAINED — stored differs, and neither of the above explains it.
 *      This is what blocks cutover (task §16).
 */

export type ReconciliationCategory =
  | "EXACT_MATCH"
  | "FIXTURE_ONLY"
  | "EXPLAINABLE_LEGACY"
  | "UNEXPLAINED";

export type ReconciliationRow = {
  tenantId: string;
  userId: string;
  skillId: string;
  storedProficiency: SkillProficiency;
  computedProficiency: SkillProficiency;
  evidenceCount: number;
  category: ReconciliationCategory;
  note: string;
};

export type TenantReconciliationSummary = {
  tenantId: string;
  total: number;
  exactMatch: number;
  fixtureOnly: number;
  explainableLegacy: number;
  unexplained: number;
  /** Bounded sample, never the full set — this is a proof artifact, not a dump. */
  unexplainedSamples: ReconciliationRow[];
};

const UNEXPLAINED_SAMPLE_LIMIT = 50;
const DEFAULT_BATCH_SIZE = 500;

function classify(
  stored: SkillProficiency,
  computed: SkillProficiency,
  evidenceCount: number,
  contributingCount: number,
  lastAssessedAt: Date | null
): { category: ReconciliationCategory; note: string } {
  if (compareRank(stored) > compareRank(MAX_GRANTABLE_LEVEL)) {
    return {
      category: "EXPLAINABLE_LEGACY",
      note: `stored level ${stored} is unreachable under Policy 1 (max grantable: ${MAX_GRANTABLE_LEVEL}) — no production writer could have produced it`,
    };
  }
  if (stored === computed) {
    return { category: "EXACT_MATCH", note: "stored equals the fresh Policy 1 computation" };
  }
  if (lastAssessedAt === null) {
    return {
      category: "FIXTURE_ONLY",
      note: "lastAssessedAt is null — no writer has ever recomputed this row (contract §F3 sets it unconditionally on first creation), so this UserSkill row was created directly, bypassing every writer",
    };
  }
  if (contributingCount === 0) {
    return {
      category: "FIXTURE_ONLY",
      note:
        evidenceCount === 0
          ? "stored is non-NONE but zero SkillEvidence rows exist for this (user, skill) — no writer can produce this from evidence"
          : `stored is non-NONE but all ${evidenceCount} evidence row(s) are non-contributing (rejected/invalid) — no writer (V1 or Policy 1) can produce this projection from them`,
    };
  }
  return {
    category: "UNEXPLAINED",
    note: `stored ${stored} != computed ${computed} with ${contributingCount} contributing evidence row(s) present — not explained by fixture or unreachable-level markers`,
  };
}

const ORDER: SkillProficiency[] = ["NONE", "BEGINNER", "INTERMEDIATE", "ADVANCED", "EXPERT"];
function compareRank(level: SkillProficiency): number {
  return ORDER.indexOf(level);
}

/**
 * Reconciles every `UserSkill` row of one tenant, in bounded batches (task
 * §22 — never loads the whole table into memory). Evidence for each batch is
 * fetched in one bulk query, not one query per row.
 */
export async function reconcileTenant(
  tenantId: string,
  opts: { batchSize?: number } = {}
): Promise<TenantReconciliationSummary> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;

  const summary: TenantReconciliationSummary = {
    tenantId,
    total: 0,
    exactMatch: 0,
    fixtureOnly: 0,
    explainableLegacy: 0,
    unexplained: 0,
    unexplainedSamples: [],
  };

  let cursor: string | undefined;
  for (;;) {
    const batch = await db.userSkill.findMany({
      where: { tenantId },
      select: { id: true, userId: true, skillId: true, proficiency: true, lastAssessedAt: true },
      orderBy: { id: "asc" },
      take: batchSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (batch.length === 0) break;

    const evidenceRows = await db.skillEvidence.findMany({
      where: {
        tenantId,
        OR: batch.map((row) => ({ userId: row.userId, skillId: row.skillId })),
      },
      select: {
        userId: true,
        skillId: true,
        verificationStatus: true,
        state: true,
        validUntil: true,
      },
    });

    const evidenceByKey = new Map<string, typeof evidenceRows>();
    for (const row of evidenceRows) {
      const key = `${row.userId}:${row.skillId}`;
      const list = evidenceByKey.get(key);
      if (list) list.push(row);
      else evidenceByKey.set(key, [row]);
    }

    const now = new Date();
    for (const row of batch) {
      const key = `${row.userId}:${row.skillId}`;
      const evidence = evidenceByKey.get(key) ?? [];
      const contributing = evidence.filter((e) => doesEvidenceContribute(e, now));
      const computed = maxProficiency(contributing.map((e) => ceilingFor(e)));

      const { category, note } = classify(
        row.proficiency,
        computed,
        evidence.length,
        contributing.length,
        row.lastAssessedAt
      );

      summary.total += 1;
      if (category === "EXACT_MATCH") summary.exactMatch += 1;
      else if (category === "FIXTURE_ONLY") summary.fixtureOnly += 1;
      else if (category === "EXPLAINABLE_LEGACY") summary.explainableLegacy += 1;
      else {
        summary.unexplained += 1;
        if (summary.unexplainedSamples.length < UNEXPLAINED_SAMPLE_LIMIT) {
          summary.unexplainedSamples.push({
            tenantId,
            userId: row.userId,
            skillId: row.skillId,
            storedProficiency: row.proficiency,
            computedProficiency: computed,
            evidenceCount: evidence.length,
            category,
            note,
          });
        }
      }
    }

    cursor = batch[batch.length - 1]?.id;
    if (batch.length < batchSize) break;
  }

  return summary;
}

export type ReconciliationTotals = {
  tenants: number;
  total: number;
  exactMatch: number;
  fixtureOnly: number;
  explainableLegacy: number;
  unexplained: number;
};

/**
 * Runs `reconcileTenant` independently per tenant (task §21 — tenants never
 * combined into one cross-tenant aggregation query) and folds the results.
 * The gate this feeds (task §16/§26): cutover is blocked while
 * `totals.unexplained > 0`.
 */
export async function reconcileAllTenants(opts: { batchSize?: number } = {}): Promise<{
  perTenant: TenantReconciliationSummary[];
  totals: ReconciliationTotals;
}> {
  const tenants = await db.tenant.findMany({ select: { id: true }, orderBy: { id: "asc" } });

  const perTenant: TenantReconciliationSummary[] = [];
  for (const tenant of tenants) {
    perTenant.push(await reconcileTenant(tenant.id, opts));
  }

  const totals = perTenant.reduce<ReconciliationTotals>(
    (acc, s) => ({
      tenants: acc.tenants + 1,
      total: acc.total + s.total,
      exactMatch: acc.exactMatch + s.exactMatch,
      fixtureOnly: acc.fixtureOnly + s.fixtureOnly,
      explainableLegacy: acc.explainableLegacy + s.explainableLegacy,
      unexplained: acc.unexplained + s.unexplained,
    }),
    { tenants: 0, total: 0, exactMatch: 0, fixtureOnly: 0, explainableLegacy: 0, unexplained: 0 }
  );

  return { perTenant, totals };
}
