import type { Prisma, SkillProficiency, UserSkill } from "@/generated/prisma/client";
import { maxProficiency } from "@/lib/domain/capability/proficiencyOrder";

type Tx = Prisma.TransactionClient;

/**
 * Per-row ceiling contribution toward UserSkill.proficiency (Phase 5 locked
 * policy — no score bands, no type-based distinction):
 *   - VERIFIED evidence -> INTERMEDIATE (the one fixed step verification grants)
 *   - UNVERIFIED evidence -> BEGINNER
 *   - PENDING evidence -> BEGINNER, same bucket as UNVERIFIED. Phase 5 never
 *     creates or transitions evidence into PENDING (see verification.ts), but
 *     the projection must not silently guess if it's ever encountered — it is
 *     explicitly treated as "not yet verified," identically to UNVERIFIED,
 *     rather than throwing or being skipped. Covered by proficiency.test.ts.
 *   - REJECTED evidence is excluded entirely by the caller's query (never
 *     reaches this function) — it contributes nothing.
 * ADVANCED/EXPERT are unreachable by any Phase 5 evidence — deferred.
 */
function ceilingFor(verificationStatus: string): SkillProficiency {
  if (verificationStatus === "VERIFIED") return "INTERMEDIATE";
  return "BEGINNER";
}

export type ProjectUserSkillParams = {
  tenantId: string;
  userId: string;
  skillId: string;
  /**
   * Timestamp recorded as UserSkill.lastAssessedAt if (and only if) this call
   * changes the projected proficiency — either by creating the UserSkill row
   * for the first time or by moving its proficiency to a different value.
   * Callers pass the triggering outcome's own timestamp (evidence creation)
   * or the current time (verification/rejection actions), never regenerated
   * ad hoc inside this function.
   */
  changeTimestamp: Date;
};

/**
 * Full recompute of UserSkill.proficiency from the complete current set of
 * non-rejected SkillEvidence for (tenantId, userId, skillId) — not an
 * incremental "add one level" algorithm. This is what makes the result
 * order-independent (Phase 5 architecture challenge, Challenge 9) and what
 * makes rejection able to correctly lower proficiency, including to NONE,
 * when no valid evidence remains (Challenge 6) — a full recompute never
 * "remembers" a stale higher value the way an incremental algorithm would.
 *
 * Only ever touches `proficiency` and, conditionally, `lastAssessedAt`.
 * Never writes `confidence` (left null/unchanged — no defensible semantic
 * exists for it yet) or `targetProficiency` or `status` — see
 * docs/V2_AI_ARCHITECTURE.md-adjacent Phase 5 spec, "UserSkill semantics".
 *
 * Must run inside the caller's own transaction (`tx`) — this function never
 * opens its own transaction, so evidence creation/verification and the
 * resulting projection commit or fail together.
 */
export async function projectUserSkill(tx: Tx, params: ProjectUserSkillParams): Promise<UserSkill> {
  const { tenantId, userId, skillId, changeTimestamp } = params;

  const evidenceRows = await tx.skillEvidence.findMany({
    where: {
      tenantId,
      userId,
      skillId,
      verificationStatus: { not: "REJECTED" },
    },
    select: { verificationStatus: true },
  });

  const newProficiency = maxProficiency(
    evidenceRows.map((row) => ceilingFor(row.verificationStatus))
  );

  const existing = await tx.userSkill.findUnique({
    where: { userId_skillId: { userId, skillId } },
  });

  if (existing && existing.proficiency === newProficiency) {
    // No change — leave lastAssessedAt untouched, per the locked definition
    // ("timestamp of the most recent capability *projection change*").
    return existing;
  }

  return tx.userSkill.upsert({
    where: { userId_skillId: { userId, skillId } },
    create: {
      tenantId,
      userId,
      skillId,
      proficiency: newProficiency,
      lastAssessedAt: changeTimestamp,
    },
    update: {
      proficiency: newProficiency,
      lastAssessedAt: changeTimestamp,
    },
  });
}
