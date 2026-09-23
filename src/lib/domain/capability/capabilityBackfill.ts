import type { EvidenceType } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import {
  type ConfidenceInput,
  CURRENT_POLICY_VERSION,
  ceilingFor,
  confidenceFor,
  doesEvidenceContribute,
  type EvidenceStanding,
} from "@/lib/domain/capability/proficiencyPolicy";

/**
 * Phase 30.2 — idempotent historical backfill (task §14/§15/§23, contract
 * §H7/§F13). Two separate, narrowly-scoped jobs, run per `UserSkill` row's
 * evidence set:
 *
 *   1. Fill `SkillEvidence.occurredAt`/`scorePercent` where still null — the
 *      documented fallback chain (contract §H7). Guarded by
 *      `updateMany({ where: { occurredAt: null } })`, so a value once set is
 *      never touched again (contract §B5 — occurredAt is immutable content;
 *      filling a null establishes it for the first time, never rewrites it).
 *   2. Write exactly one BASELINE `SkillProficiencyEvent` per `UserSkill` row
 *      that has never had one (`eventSeq === 0`, the checkpoint task §23
 *      requires). The event's `newProficiency` is the row's EXISTING stored
 *      value, never a freshly recomputed one (task §16's ban on "force
 *      UserSkill to the new value and declare success" — that is
 *      reconciliation's job, which must already have proven this value
 *      correct or explained before backfill runs, task §18 step 4).
 *      `previousProficiency` is null: this establishes history, it does not
 *      fabricate a transition that never happened (contract §15).
 *
 * Never calls `projectUserSkill` and never writes `UserSkill.proficiency` —
 * this is not a recompute, it is metadata/history establishment for a value
 * already reconciled as correct or explained.
 */

export type TenantBackfillResult = {
  tenantId: string;
  rowsConsidered: number;
  rowsBaselined: number;
  rowsAlreadyBaselined: number;
  evidenceOccurredAtFilled: number;
  evidenceScorePercentFilled: number;
  failures: { userId: string; skillId: string; error: string }[];
};

const DEFAULT_BATCH_SIZE = 200;

type EvidenceForBackfill = {
  id: string;
  type: EvidenceType;
  sourceType: string;
  sourceId: string | null;
  score: number | null;
  verificationStatus: EvidenceStanding["verificationStatus"];
  state: EvidenceStanding["state"];
  validUntil: Date | null;
  occurredAt: Date | null;
  createdAt: Date;
};

/**
 * Resolves and persists `occurredAt`/`scorePercent` for the given rows'
 * evidence still missing it (contract §H7's fallback chain), batched by
 * sourceType to avoid one lookup per row. Returns the resolved values so the
 * caller's in-memory copy can be updated without a second read.
 */
async function fillMissingEvidenceMetadata(
  tenantId: string,
  evidence: EvidenceForBackfill[]
): Promise<{ occurredAtFilled: number; scorePercentFilled: number }> {
  const needsOccurredAt = evidence.filter((e) => e.occurredAt === null);
  let occurredAtFilled = 0;
  let scorePercentFilled = 0;

  const courseSourceIds = needsOccurredAt
    .filter((e) => e.sourceType === "Course" && e.sourceId)
    .map((e) => e.sourceId as string);
  const quizSourceIds = needsOccurredAt
    .filter((e) => e.sourceType === "Quiz" && e.sourceId)
    .map((e) => e.sourceId as string);
  const legacyQuizAttemptIds = needsOccurredAt
    .filter((e) => e.sourceType === "QuizAttempt" && e.sourceId)
    .map((e) => e.sourceId as string);
  // scorePercent (unlike occurredAt) can still be missing on a row whose
  // occurredAt is already set, so this set is drawn from ALL of this batch's
  // evidence, not just `needsOccurredAt`.
  const submissionIds = evidence
    .filter((e) => e.sourceType === "AssignmentSubmission" && e.sourceId)
    .map((e) => e.sourceId as string);

  const [enrollments, quizAttempts, legacyAttempts, submissions] = await Promise.all([
    courseSourceIds.length
      ? db.enrollment.findMany({
          where: { courseId: { in: courseSourceIds } },
          select: { courseId: true, completedAt: true, updatedAt: true },
        })
      : Promise.resolve([]),
    quizSourceIds.length
      ? db.quizAttempt.findMany({
          where: { quizId: { in: quizSourceIds }, isPassed: true },
          select: { quizId: true, completedAt: true },
          orderBy: { completedAt: "asc" },
        })
      : Promise.resolve([]),
    legacyQuizAttemptIds.length
      ? db.quizAttempt.findMany({
          where: { id: { in: legacyQuizAttemptIds } },
          select: { id: true, completedAt: true },
        })
      : Promise.resolve([]),
    submissionIds.length
      ? db.assignmentSubmission.findMany({
          where: { id: { in: submissionIds } },
          select: {
            id: true,
            gradedAt: true,
            score: true,
            assignment: { select: { maxScore: true } },
          },
        })
      : Promise.resolve([]),
  ]);

  const earliestByCourse = new Map<string, Date>();
  for (const e of enrollments) {
    earliestByCourse.set(e.courseId, e.completedAt ?? e.updatedAt);
  }
  const earliestByQuiz = new Map<string, Date>();
  for (const a of quizAttempts) {
    if (!earliestByQuiz.has(a.quizId)) earliestByQuiz.set(a.quizId, a.completedAt);
  }
  const byLegacyAttemptId = new Map(legacyAttempts.map((a) => [a.id, a.completedAt]));
  const bySubmissionId = new Map(submissions.map((s) => [s.id, s]));

  for (const e of needsOccurredAt) {
    let resolved: Date | null = null;
    if (e.sourceType === "Course" && e.sourceId)
      resolved = earliestByCourse.get(e.sourceId) ?? null;
    else if (e.sourceType === "Quiz" && e.sourceId)
      resolved = earliestByQuiz.get(e.sourceId) ?? null;
    else if (e.sourceType === "QuizAttempt" && e.sourceId)
      resolved = byLegacyAttemptId.get(e.sourceId) ?? null;
    else if (e.sourceType === "AssignmentSubmission" && e.sourceId)
      resolved = bySubmissionId.get(e.sourceId)?.gradedAt ?? null;
    // documented fallback (contract §H7): the evidence's own creation time.
    const finalValue = resolved ?? e.createdAt;

    const result = await db.skillEvidence.updateMany({
      where: { id: e.id, tenantId, occurredAt: null },
      data: { occurredAt: finalValue },
    });
    if (result.count > 0) {
      occurredAtFilled += 1;
      e.occurredAt = finalValue;
    }
  }

  for (const e of evidence) {
    if (e.sourceType !== "AssignmentSubmission" || !e.sourceId) continue;
    const submission = bySubmissionId.get(e.sourceId);
    if (!submission || submission.score === null) continue;
    const scorePercent = (submission.score / submission.assignment.maxScore) * 100;
    const result = await db.skillEvidence.updateMany({
      where: { id: e.id, tenantId, scorePercent: null },
      data: { scorePercent },
    });
    if (result.count > 0) scorePercentFilled += 1;
  }

  return { occurredAtFilled, scorePercentFilled };
}

/**
 * Backfills one tenant's `UserSkill` rows still at `eventSeq === 0`
 * (task §23's restart checkpoint). Each successfully processed row leaves
 * `eventSeq === 0` — permanently excluding it from the next query — which is
 * what makes repeated calls to this function naturally idempotent and safely
 * interruptible: a killed run simply leaves the remaining rows still at
 * `eventSeq === 0` for the next call to pick up.
 */
export async function backfillTenant(
  tenantId: string,
  opts: { batchSize?: number; asOf?: Date } = {}
): Promise<TenantBackfillResult> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const asOf = opts.asOf ?? new Date();

  const result: TenantBackfillResult = {
    tenantId,
    rowsConsidered: 0,
    rowsBaselined: 0,
    rowsAlreadyBaselined: 0,
    evidenceOccurredAtFilled: 0,
    evidenceScorePercentFilled: 0,
    failures: [],
  };

  const failedIds = new Set<string>();

  for (;;) {
    const batch = await db.userSkill.findMany({
      where: { tenantId, eventSeq: 0, id: { notIn: [...failedIds] } },
      select: { id: true, userId: true, skillId: true, proficiency: true, createdAt: true },
      orderBy: { id: "asc" },
      take: batchSize,
    });
    if (batch.length === 0) break;
    result.rowsConsidered += batch.length;

    const evidenceRows = await db.skillEvidence.findMany({
      where: { tenantId, OR: batch.map((row) => ({ userId: row.userId, skillId: row.skillId })) },
      select: {
        id: true,
        type: true,
        sourceType: true,
        sourceId: true,
        score: true,
        verificationStatus: true,
        state: true,
        validUntil: true,
        occurredAt: true,
        createdAt: true,
        userId: true,
        skillId: true,
      },
    });

    const metaResult = await fillMissingEvidenceMetadata(tenantId, evidenceRows);
    result.evidenceOccurredAtFilled += metaResult.occurredAtFilled;
    result.evidenceScorePercentFilled += metaResult.scorePercentFilled;

    const evidenceByKey = new Map<string, EvidenceForBackfill[]>();
    for (const row of evidenceRows) {
      const key = `${row.userId}:${row.skillId}`;
      const list = evidenceByKey.get(key);
      if (list) list.push(row);
      else evidenceByKey.set(key, [row]);
    }

    for (const row of batch) {
      try {
        const key = `${row.userId}:${row.skillId}`;
        const evidence = evidenceByKey.get(key) ?? [];
        const contributing = evidence.filter((e) => doesEvidenceContribute(e, asOf));
        const confidenceInputs: ConfidenceInput[] = contributing.map((e) => ({
          verificationStatus: e.verificationStatus,
          state: e.state,
          validUntil: e.validUntil,
          type: e.type,
          occurredAt: e.occurredAt,
        }));
        // Confidence is computed for the SUPPORTING level (what the stored
        // proficiency actually is), never for a freshly recomputed level —
        // backfill never recomputes the projection itself (see file header).
        const confidence = confidenceFor(row.proficiency, confidenceInputs, asOf);
        const contributingSnapshot = contributing.map((e) => ({
          evidenceId: e.id,
          type: e.type,
          verificationStatus: e.verificationStatus,
          grant: ceilingFor(e),
        }));
        const earliestOccurredAt = contributing
          .map((e) => e.occurredAt)
          .filter((d): d is Date => d !== null)
          .sort((a, b) => a.getTime() - b.getTime())[0];

        const wrote = await db.$transaction(async (tx) => {
          const [locked] = await tx.$queryRaw<{ eventSeq: number }[]>`
            SELECT "eventSeq" FROM "UserSkill" WHERE id = ${row.id} FOR UPDATE
          `;
          // Someone else (a concurrent backfill batch, or live traffic)
          // already established history for this row since it was read
          // into this batch — leave it alone, count it, move on.
          if (!locked || locked.eventSeq !== 0) return false;

          await tx.userSkill.update({
            where: { id: row.id },
            data: {
              evidenceConfidence: confidence,
              policyVersion: CURRENT_POLICY_VERSION,
              eventSeq: 1,
            },
          });
          await tx.skillProficiencyEvent.create({
            data: {
              tenantId,
              userId: row.userId,
              skillId: row.skillId,
              seq: 1,
              cause: "BASELINE",
              evidenceId: null,
              evidenceRevision: null,
              actorId: null,
              actorRole: null,
              reason:
                "Phase 30.2 backfill — establishes history for a pre-existing projection; not a live transition",
              previousProficiency: null,
              newProficiency: row.proficiency,
              previousConfidence: null,
              newConfidence: confidence,
              policyVersion: CURRENT_POLICY_VERSION,
              contributing: contributingSnapshot,
              occurredAt: earliestOccurredAt ?? row.createdAt,
            },
          });
          return true;
        });

        if (wrote) result.rowsBaselined += 1;
        else result.rowsAlreadyBaselined += 1;
      } catch (err) {
        failedIds.add(row.id);
        result.failures.push({
          userId: row.userId,
          skillId: row.skillId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (batch.length < batchSize) break;
  }

  return result;
}

export type BackfillTotals = {
  tenants: number;
  rowsConsidered: number;
  rowsBaselined: number;
  rowsAlreadyBaselined: number;
  evidenceOccurredAtFilled: number;
  evidenceScorePercentFilled: number;
  failures: number;
};

/** Runs `backfillTenant` independently per tenant (task §21) and folds the results. */
export async function backfillAllTenants(opts: { batchSize?: number; asOf?: Date } = {}): Promise<{
  perTenant: TenantBackfillResult[];
  totals: BackfillTotals;
}> {
  const tenants = await db.tenant.findMany({ select: { id: true }, orderBy: { id: "asc" } });
  const perTenant: TenantBackfillResult[] = [];
  for (const tenant of tenants) {
    perTenant.push(await backfillTenant(tenant.id, opts));
  }
  const totals = perTenant.reduce<BackfillTotals>(
    (acc, r) => ({
      tenants: acc.tenants + 1,
      rowsConsidered: acc.rowsConsidered + r.rowsConsidered,
      rowsBaselined: acc.rowsBaselined + r.rowsBaselined,
      rowsAlreadyBaselined: acc.rowsAlreadyBaselined + r.rowsAlreadyBaselined,
      evidenceOccurredAtFilled: acc.evidenceOccurredAtFilled + r.evidenceOccurredAtFilled,
      evidenceScorePercentFilled: acc.evidenceScorePercentFilled + r.evidenceScorePercentFilled,
      failures: acc.failures + r.failures.length,
    }),
    {
      tenants: 0,
      rowsConsidered: 0,
      rowsBaselined: 0,
      rowsAlreadyBaselined: 0,
      evidenceOccurredAtFilled: 0,
      evidenceScorePercentFilled: 0,
      failures: 0,
    }
  );
  return { perTenant, totals };
}
