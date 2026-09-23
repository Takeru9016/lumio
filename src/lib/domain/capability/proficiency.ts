import type {
  EvidenceConfidence,
  Prisma,
  ProficiencyEventCause,
  Role,
  SkillProficiency,
  UserSkill,
} from "@/generated/prisma/client";
import { maxProficiency } from "@/lib/domain/capability/proficiencyOrder";
import {
  type ConfidenceInput,
  CURRENT_POLICY_VERSION,
  ceilingFor,
  confidenceFor,
  doesEvidenceContribute,
} from "@/lib/domain/capability/proficiencyPolicy";

type Tx = Prisma.TransactionClient;

export type ProjectUserSkillParams = {
  tenantId: string;
  userId: string;
  skillId: string;
  /**
   * Timestamp recorded as UserSkill.lastAssessedAt if (and only if) this call
   * changes the projected proficiency, and as SkillProficiencyEvent.occurredAt
   * (business time, contract §F9 — may be backdated, e.g. Enrollment.completedAt).
   * Never used to judge evidence validity — see `now` below.
   */
  changeTimestamp: Date;
  /**
   * Why this recompute is happening (contract §F7). Defaults to RECALCULATED —
   * the reserved cause for a recompute with no specific evidence-transition
   * context (every pre-Phase-30.2 call site, and any future ad hoc recompute).
   * Real evidence-writing/verification call sites (outcomes.ts, verification.ts)
   * pass the precise cause.
   */
  cause?: ProficiencyEventCause;
  /** The evidence row this transition acted on, and the revision it produced (contract §F6). */
  evidenceId?: string;
  evidenceRevision?: number;
  /** Null/omitted means the system acted (contract §F6). */
  actorId?: string;
  actorRole?: Role;
  reason?: string;
};

type LockedUserSkill = {
  id: string;
  proficiency: SkillProficiency;
  evidenceConfidence: EvidenceConfidence | null;
  eventSeq: number;
};

/**
 * The one canonical recomputation path (contract §A3/§I2, task §1/I2) — every
 * runtime evidence-processing path (outcomes.ts, verification.ts) converges
 * on this function; nothing else may write `UserSkill.proficiency`. Kept as
 * `projectUserSkill` rather than renamed to the task's pseudocode name
 * `recomputeUserSkill`: every existing call site and `proficiency.test.ts`
 * assertion stays byte-identical (contract §M, "existing suites MUST pass
 * unmodified"), and the behavior below is exactly what `recomputeUserSkill`
 * describes — the name is cosmetic, not structural. Documented here rather
 * than left implicit, the same discipline 30.1 used for the `readiness.ts`
 * file-placement deviation.
 *
 * Implements contract §F1's six-step sequence:
 *   1. ensure the UserSkill row exists (ON CONFLICT DO NOTHING)
 *   2. SELECT ... FOR UPDATE it
 *   3. read the full evidence set under that lock
 *   4. compute level + confidence (Policy 1, `proficiencyPolicy.ts`)
 *   5. write the projection, eventSeq, policyVersion
 *   6. append the event, in the same transaction (§9/§10 — no best-effort catch)
 *
 * Must run inside the caller's own transaction (`tx`) — never opens its own,
 * so evidence creation/verification and the resulting projection (and its
 * history event) commit or fail together.
 */
export async function projectUserSkill(tx: Tx, params: ProjectUserSkillParams): Promise<UserSkill> {
  const {
    tenantId,
    userId,
    skillId,
    changeTimestamp,
    cause = "RECALCULATED",
    evidenceId,
    evidenceRevision,
    actorId,
    actorRole,
    reason,
  } = params;

  // Evidence validity (expiry, freshness) is judged as of the actual moment
  // of this recompute, never as of a possibly-backdated `changeTimestamp` —
  // contract §A2 ("as of its last write") means the write's own wall-clock
  // moment, not the business event that triggered it.
  const now = new Date();

  // F1 step 1 — ensure the row exists without racing a concurrent first-time
  // creation (task §13). `skipDuplicates` compiles to ON CONFLICT DO NOTHING
  // on the existing `[userId, skillId]` unique constraint. `count === 1` means
  // THIS call inserted the row — the only case with truly no prior state.
  const inserted = await tx.userSkill.createMany({
    data: [{ tenantId, userId, skillId }],
    skipDuplicates: true,
  });
  const wasJustCreated = inserted.count === 1;

  // F1 step 2 — lock it. The row is guaranteed to exist by now (this call's
  // insert, or a concurrent one that committed first and released its own
  // lock) — mirrors the repo's established FOR UPDATE convention
  // (learning-path/paths.ts's lockPath).
  const [locked] = await tx.$queryRaw<LockedUserSkill[]>`
    SELECT id, proficiency, "evidenceConfidence", "eventSeq"
    FROM "UserSkill"
    WHERE "userId" = ${userId} AND "skillId" = ${skillId}
    FOR UPDATE
  `;
  if (!locked) {
    throw new Error(
      `UserSkill row missing immediately after creation (user ${userId}, skill ${skillId})`
    );
  }

  // F1 step 3 — the FULL current evidence set, not pre-filtered in SQL: the
  // policy alone decides what contributes, which is what makes INV2/INV3/INV4
  // provable from this one read rather than assumed from a WHERE clause.
  // Ordered by id for a deterministic `contributing` snapshot (task §4).
  const evidenceRows = await tx.skillEvidence.findMany({
    where: { tenantId, userId, skillId },
    select: {
      id: true,
      type: true,
      verificationStatus: true,
      state: true,
      validUntil: true,
      occurredAt: true,
    },
    orderBy: { id: "asc" },
  });

  const contributing = evidenceRows.filter((e) => doesEvidenceContribute(e, now));

  // F1 step 4 — deterministic, order-independent by construction (maxProficiency).
  const newProficiency = maxProficiency(contributing.map((e) => ceilingFor(e)));
  const confidenceInputs: ConfidenceInput[] = contributing.map((e) => ({
    verificationStatus: e.verificationStatus,
    state: e.state,
    validUntil: e.validUntil,
    type: e.type,
    occurredAt: e.occurredAt,
  }));
  const newConfidence = confidenceFor(newProficiency, confidenceInputs, now);

  const previousProficiency = wasJustCreated ? null : locked.proficiency;
  // Creation itself counts as a transition worth recording (from "no
  // projection" to whatever it starts at) — matches V1's own exact behavior
  // (the old `!existing` branch always wrote `lastAssessedAt` on creation,
  // regardless of the resulting value).
  const levelChanged = wasJustCreated || locked.proficiency !== newProficiency;

  if (!levelChanged) {
    // Cache-only refresh (contract §D1: confidence is a derived cache, kept
    // current independent of whether the level itself moved) — never
    // lastAssessedAt, never eventSeq, never an event. This is the exact
    // no-op case task §7/P5 forbids an event for: a recompute of an
    // already-existing row whose value doesn't change.
    return tx.userSkill.update({
      where: { userId_skillId: { userId, skillId } },
      data: { evidenceConfidence: newConfidence, policyVersion: CURRENT_POLICY_VERSION },
    });
  }

  const nextSeq = locked.eventSeq + 1;

  const updated = await tx.userSkill.update({
    where: { userId_skillId: { userId, skillId } },
    data: {
      proficiency: newProficiency,
      lastAssessedAt: changeTimestamp,
      evidenceConfidence: newConfidence,
      policyVersion: CURRENT_POLICY_VERSION,
      eventSeq: nextSeq,
    },
  });

  // F1 step 6 — same transaction as the projection write (§9): a failure
  // here rolls back the projection too. Never wrapped in a best-effort catch
  // (§10) — the projection and its history event are one integrity unit.
  await tx.skillProficiencyEvent.create({
    data: {
      tenantId,
      userId,
      skillId,
      seq: nextSeq,
      cause,
      evidenceId: evidenceId ?? null,
      evidenceRevision: evidenceId ? (evidenceRevision ?? 0) : null,
      actorId: actorId ?? null,
      actorRole: actorRole ?? null,
      reason: reason ?? null,
      previousProficiency,
      newProficiency,
      previousConfidence: wasJustCreated ? null : locked.evidenceConfidence,
      newConfidence,
      policyVersion: CURRENT_POLICY_VERSION,
      contributing: contributing.map((e) => ({
        evidenceId: e.id,
        type: e.type,
        verificationStatus: e.verificationStatus,
        grant: ceilingFor(e),
      })),
      occurredAt: changeTimestamp,
    },
  });

  return updated;
}
