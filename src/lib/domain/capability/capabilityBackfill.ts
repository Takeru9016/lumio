import type { EvidenceType, SkillProficiency } from "@/generated/prisma/client";
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
  userId: string;
};

/** `${userId}:${sourceId}` — every lookup map in this file is keyed by this pair, never by sourceId alone (D24). */
function learnerSourceKey(userId: string, sourceId: string): string {
  return `${userId}:${sourceId}`;
}

/**
 * Resolves and persists `occurredAt`/`scorePercent` for the given rows'
 * evidence still missing it (contract §H7's fallback chain), batched by
 * sourceType to avoid one lookup per row. Returns the resolved values so the
 * caller's in-memory copy can be updated without a second read.
 *
 * D24 (docs/PHASE_30.3_DISCOVERY.md §1): every lookup below is scoped to
 * (tenantId, userId, sourceId), never sourceId alone. The pre-30.3 version of
 * this function queried Enrollment/QuizAttempt by course/quiz id only, with
 * no learner filter, and folded the results into a map keyed only by
 * course/quiz id — so the last-iterated (or, for quiz, the earliest-passing)
 * row won for every learner sharing that course/quiz, not each learner's
 * own. Fixed by requiring `userId` in every WHERE clause and keying every
 * map by `learnerSourceKey(userId, sourceId)`. Enrollment/QuizAttempt/
 * AssignmentSubmission carry no `tenantId` column of their own, so tenant
 * consistency is enforced through the owning Course's `tenantId` via the
 * relevant relation chain — a cross-tenant `sourceId` (e.g. a malformed or
 * forged evidence row) matches nothing and falls through to the documented
 * `createdAt` fallback, never another tenant's data.
 */
async function fillMissingEvidenceMetadata(
  tenantId: string,
  evidence: EvidenceForBackfill[]
): Promise<{ occurredAtFilled: number; scorePercentFilled: number }> {
  const needsOccurredAt = evidence.filter((e) => e.occurredAt === null);
  let occurredAtFilled = 0;
  let scorePercentFilled = 0;

  const courseRows = needsOccurredAt.filter((e) => e.sourceType === "Course" && e.sourceId);
  const quizRows = needsOccurredAt.filter((e) => e.sourceType === "Quiz" && e.sourceId);
  const legacyQuizAttemptRows = needsOccurredAt.filter(
    (e) => e.sourceType === "QuizAttempt" && e.sourceId
  );
  // scorePercent (unlike occurredAt) can still be missing on a row whose
  // occurredAt is already set, so this set is drawn from ALL of this batch's
  // evidence, not just `needsOccurredAt`.
  const submissionRows = evidence.filter(
    (e) => e.sourceType === "AssignmentSubmission" && e.sourceId
  );

  const courseSourceIds = [...new Set(courseRows.map((e) => e.sourceId as string))];
  const courseUserIds = [...new Set(courseRows.map((e) => e.userId))];
  const quizSourceIds = [...new Set(quizRows.map((e) => e.sourceId as string))];
  const quizUserIds = [...new Set(quizRows.map((e) => e.userId))];
  const legacyAttemptIds = [...new Set(legacyQuizAttemptRows.map((e) => e.sourceId as string))];
  const legacyUserIds = [...new Set(legacyQuizAttemptRows.map((e) => e.userId))];
  const submissionIds = [...new Set(submissionRows.map((e) => e.sourceId as string))];
  const submissionUserIds = [...new Set(submissionRows.map((e) => e.userId))];

  const [enrollments, quizAttempts, legacyAttempts, submissions] = await Promise.all([
    courseSourceIds.length
      ? db.enrollment.findMany({
          where: {
            courseId: { in: courseSourceIds },
            userId: { in: courseUserIds },
            course: { tenantId },
          },
          select: { courseId: true, userId: true, completedAt: true, updatedAt: true },
        })
      : Promise.resolve([]),
    quizSourceIds.length
      ? db.quizAttempt.findMany({
          where: {
            quizId: { in: quizSourceIds },
            userId: { in: quizUserIds },
            isPassed: true,
            quiz: { lesson: { section: { course: { tenantId } } } },
          },
          select: { quizId: true, userId: true, completedAt: true },
          orderBy: { completedAt: "asc" },
        })
      : Promise.resolve([]),
    legacyAttemptIds.length
      ? db.quizAttempt.findMany({
          where: {
            id: { in: legacyAttemptIds },
            userId: { in: legacyUserIds },
            quiz: { lesson: { section: { course: { tenantId } } } },
          },
          select: { id: true, userId: true, completedAt: true },
        })
      : Promise.resolve([]),
    submissionIds.length
      ? db.assignmentSubmission.findMany({
          where: {
            id: { in: submissionIds },
            userId: { in: submissionUserIds },
            assignment: { lesson: { section: { course: { tenantId } } } },
          },
          select: {
            id: true,
            userId: true,
            gradedAt: true,
            score: true,
            assignment: { select: { maxScore: true } },
          },
        })
      : Promise.resolve([]),
  ]);

  const earliestByCourse = new Map<string, Date>();
  for (const e of enrollments) {
    earliestByCourse.set(learnerSourceKey(e.userId, e.courseId), e.completedAt ?? e.updatedAt);
  }
  const earliestByQuiz = new Map<string, Date>();
  for (const a of quizAttempts) {
    const key = learnerSourceKey(a.userId, a.quizId);
    if (!earliestByQuiz.has(key)) earliestByQuiz.set(key, a.completedAt);
  }
  const byLegacyAttempt = new Map(
    legacyAttempts.map((a) => [learnerSourceKey(a.userId, a.id), a.completedAt])
  );
  const bySubmission = new Map(submissions.map((s) => [learnerSourceKey(s.userId, s.id), s]));

  for (const e of needsOccurredAt) {
    let resolved: Date | null = null;
    if (e.sourceType === "Course" && e.sourceId)
      resolved = earliestByCourse.get(learnerSourceKey(e.userId, e.sourceId)) ?? null;
    else if (e.sourceType === "Quiz" && e.sourceId)
      resolved = earliestByQuiz.get(learnerSourceKey(e.userId, e.sourceId)) ?? null;
    else if (e.sourceType === "QuizAttempt" && e.sourceId)
      resolved = byLegacyAttempt.get(learnerSourceKey(e.userId, e.sourceId)) ?? null;
    else if (e.sourceType === "AssignmentSubmission" && e.sourceId)
      resolved = bySubmission.get(learnerSourceKey(e.userId, e.sourceId))?.gradedAt ?? null;
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
    const submission = bySubmission.get(learnerSourceKey(e.userId, e.sourceId));
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

// ---------------------------------------------------------------------------
// D24 remediation (docs/PHASE_30.3_DISCOVERY.md §1, §34 D24) — a deliberate,
// one-time EXCEPTION to contract §B5's "occurredAt, once set, is never
// rewritten" rule, for exactly the rows the pre-30.3 backfill (above) wrote
// wrong. This is NOT part of the ordinary fill-nulls-only path and is never
// called from `backfillTenant`/`fillMissingEvidenceMetadata` — it is a
// separate, explicitly-invoked correction, run once against a real database
// (never automatically, never on every backfill call, so a normal restart of
// `backfillTenant` can never accidentally re-trigger it).
//
// Rule (exactly the task's own three-way split):
//   correctly sourced occurredAt        -> preserve, untouched
//   demonstrably misattributed          -> repair to the row's OWN authoritative value
//   unknown/ambiguous                   -> never touched, never guessed, counted separately
//
// "Demonstrably misattributed" is defined narrowly and empirically, not as
// "differs from the recomputed value": a mismatch is repaired ONLY when the
// evidence's current `occurredAt` exactly equals ANOTHER learner's candidate
// timestamp for the same course/quiz (the collapse signature the pre-30.3
// bug actually produces — proven this session by discriminating a real
// sample down to the exact millisecond, docs/PHASE_30.3_DISCOVERY.md §1). A
// mismatch that matches no other learner's value either is left alone as
// ambiguous — it may be unrelated fixture/legacy data this remediation has
// no business rewriting, and D24 explicitly forbids inventing a value.
//
// Scope: COURSE_COMPLETION and QUIZ_SCORE only — the two types the bug
// actually touches (Map keyed by course/quiz id, no learner filter).
// ASSESSMENT (submission id) and legacy "QuizAttempt" (attempt id) evidence
// were already keyed by an id unique to one learner and were never
// contaminated by this mechanism (docs/PHASE_30.3_DISCOVERY.md §16); nothing
// here touches them.
// ---------------------------------------------------------------------------

export type RepairedOccurredAtRecord = {
  evidenceId: string;
  userId: string;
  skillId: string;
  sourceType: "Course" | "Quiz";
  sourceId: string;
  previousOccurredAt: string;
  newOccurredAt: string;
};

export type OccurredAtRemediationReport = {
  tenantId: string;
  rowsChecked: number;
  repaired: number;
  ambiguous: number;
  alreadyCorrect: number;
  /** Classified `ambiguous` because this evidence's OWN learner has no resolvable authoritative value at all (e.g. enrollment still ACTIVE, no completedAt). */
  ambiguousNoOwnSource: number;
  /** Classified `ambiguous` because the mismatch doesn't match any other learner's candidate value — not the bug's own signature, not this remediation's business to guess at. */
  ambiguousUnattributable: number;
  /** A repair was warranted but a genuine concurrent write raced the classification (CAS re-check failed) or the row disappeared — never counted as `repaired`; safe to pick up on the next run. */
  stale: number;
  /** Evidence rows with a null `sourceId` (cannot resolve any candidate at all) — never counted in any other bucket. */
  skipped: number;
  repairedRecords: RepairedOccurredAtRecord[];
  ambiguousEvidenceIds: string[];
};

type CandidateValue = { userId: string; ownValue: Date | null; matchValue: Date };

type ClassifyOutcome =
  | { kind: "correct" }
  | { kind: "ambiguous"; reason: "NO_OWN_SOURCE" | "UNATTRIBUTABLE_MISMATCH" }
  | { kind: "repaired"; record: RepairedOccurredAtRecord }
  /** The row changed between this call's read and its lock — a genuine concurrent write, not this classification's to overwrite. Counted separately so `repaired`/`ambiguous` totals never silently include a write that didn't happen. */
  | { kind: "stale" };

/**
 * Classifies and, if warranted, repairs ONE evidence row's `occurredAt`
 * inside its own transaction. Content and cache only: never creates or
 * recomputes the `UserSkill` projection, never calls `projectUserSkill`.
 *
 * Lock `SkillEvidence` first (`SkillEvidence` then `UserSkill`, the
 * established order — contract §Q "Amends E1, adds transitions" / D21),
 * re-check under the lock that `occurredAt` still equals the value this
 * call classified against (a CAS guard — a concurrent write since the read
 * makes the classification stale, so this call backs off and reports
 * `stale` rather than overwriting it), write the corrected `occurredAt`,
 * then — only if a `UserSkill` row already exists (locked separately, never
 * created) — recompute the confidence cache directly from the current
 * evidence set and write only `evidenceConfidence`/`policyVersion`.
 * `proficiency`, `lastAssessedAt`, `eventSeq` are never touched. No
 * `SkillProficiencyEvent`, no `EvidenceStandingEvent` (a content
 * correction, not a standing transition).
 */
async function classifyAndRepairOne(
  tenantId: string,
  userId: string,
  skillId: string,
  evidenceId: string,
  sourceType: "Course" | "Quiz",
  sourceId: string,
  currentOccurredAt: Date,
  ownValue: Date | null,
  otherLearnersValues: Date[]
): Promise<ClassifyOutcome> {
  if (ownValue === null) return { kind: "ambiguous", reason: "NO_OWN_SOURCE" };
  if (currentOccurredAt.getTime() === ownValue.getTime()) return { kind: "correct" };
  const matchesAnotherLearner = otherLearnersValues.some(
    (v) => v.getTime() === currentOccurredAt.getTime()
  );
  if (!matchesAnotherLearner) return { kind: "ambiguous", reason: "UNATTRIBUTABLE_MISMATCH" };

  const wrote = await db.$transaction(async (tx) => {
    const [lockedEvidence] = await tx.$queryRaw<{ id: string; occurredAt: Date | null }[]>`
      SELECT id, "occurredAt" FROM "SkillEvidence" WHERE id = ${evidenceId} FOR UPDATE
    `;
    if (!lockedEvidence) return false; // row disappeared between read and lock
    if (
      lockedEvidence.occurredAt === null ||
      lockedEvidence.occurredAt.getTime() !== currentOccurredAt.getTime()
    ) {
      return false; // stale classification — someone else already changed it; back off
    }

    await tx.skillEvidence.update({
      where: { id: lockedEvidence.id },
      data: { occurredAt: ownValue },
    });

    const [lockedProjection] = await tx.$queryRaw<{ id: string; proficiency: SkillProficiency }[]>`
      SELECT id, proficiency FROM "UserSkill" WHERE "userId" = ${userId} AND "skillId" = ${skillId} FOR UPDATE
    `;
    if (lockedProjection) {
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
      });
      const now = new Date();
      const contributing = evidenceRows.filter((e) => doesEvidenceContribute(e, now));
      const confidenceInputs: ConfidenceInput[] = contributing.map((e) => ({
        verificationStatus: e.verificationStatus,
        state: e.state,
        validUntil: e.validUntil,
        type: e.type,
        occurredAt: e.occurredAt,
      }));
      // Confidence for the EXISTING stored level — never recomputed, matching
      // the ordinary backfill path's own discipline (§9 above).
      const confidence = confidenceFor(lockedProjection.proficiency, confidenceInputs, now);
      await tx.userSkill.update({
        where: { id: lockedProjection.id },
        data: { evidenceConfidence: confidence, policyVersion: CURRENT_POLICY_VERSION },
      });
    } // else: never create a projection as a side effect of a content fix
    return true;
  });

  if (!wrote) return { kind: "stale" };
  return {
    kind: "repaired",
    record: {
      evidenceId,
      userId,
      skillId,
      sourceType,
      sourceId,
      previousOccurredAt: currentOccurredAt.toISOString(),
      newOccurredAt: ownValue.toISOString(),
    },
  };
}

/**
 * Runs the D24 remediation for one tenant. Deterministic, learner-scoped,
 * tenant-scoped (every lookup below matches `fillMissingEvidenceMetadata`'s
 * own tenant-consistency discipline via the owning Course), idempotent (a
 * row already at its own authoritative value classifies as "correct" and is
 * never touched again — safe to re-run), and auditable (returns a full
 * report; the caller is responsible for persisting it as an artifact,
 * mirroring 30.2's own `docs/PHASE_30.2_RECONCILIATION.json` convention —
 * this module does not write a new table for it, per the discovery's own
 * "don't invent a table" conclusion, docs/PHASE_30.3_DISCOVERY.md §26).
 */
export async function remediateOccurredAtMisattribution(
  tenantId: string
): Promise<OccurredAtRemediationReport> {
  const report: OccurredAtRemediationReport = {
    tenantId,
    rowsChecked: 0,
    repaired: 0,
    ambiguous: 0,
    alreadyCorrect: 0,
    ambiguousNoOwnSource: 0,
    ambiguousUnattributable: 0,
    stale: 0,
    skipped: 0,
    repairedRecords: [],
    ambiguousEvidenceIds: [],
  };

  const [courseEvidence, quizEvidence] = await Promise.all([
    db.skillEvidence.findMany({
      where: { tenantId, sourceType: "Course", occurredAt: { not: null } },
      select: { id: true, userId: true, skillId: true, sourceId: true, occurredAt: true },
    }),
    db.skillEvidence.findMany({
      where: { tenantId, sourceType: "Quiz", occurredAt: { not: null } },
      select: { id: true, userId: true, skillId: true, sourceId: true, occurredAt: true },
    }),
  ]);
  report.rowsChecked = courseEvidence.length + quizEvidence.length;

  const courseIds = [
    ...new Set(courseEvidence.map((e) => e.sourceId).filter((id): id is string => !!id)),
  ];
  const quizIds = [
    ...new Set(quizEvidence.map((e) => e.sourceId).filter((id): id is string => !!id)),
  ];

  const [enrollments, attempts] = await Promise.all([
    courseIds.length
      ? db.enrollment.findMany({
          where: { courseId: { in: courseIds }, course: { tenantId } },
          select: { courseId: true, userId: true, completedAt: true, updatedAt: true },
        })
      : Promise.resolve([]),
    quizIds.length
      ? db.quizAttempt.findMany({
          where: {
            quizId: { in: quizIds },
            isPassed: true,
            quiz: { lesson: { section: { course: { tenantId } } } },
          },
          select: { quizId: true, userId: true, completedAt: true },
          orderBy: { completedAt: "asc" },
        })
      : Promise.resolve([]),
  ]);

  // `ownValue` is the STRICT authoritative value (never a fallback) — used
  // only to decide what THIS learner's own repair target is. `matchValue`
  // is the wider fallback (`completedAt ?? updatedAt`) — used only to
  // detect whether another learner's candidate is what the bug actually
  // wrote, matching `fillMissingEvidenceMetadata`'s own resolution. A
  // learner whose own `completedAt` is null (still enrolled, not yet
  // completed) must never be auto-repaired to a moving `updatedAt` value —
  // that is exactly "replace a historical timestamp because a newer one is
  // available," which D24 explicitly forbids (docs/PHASE_30.3_DISCOVERY.md
  // §1, task's own D24 remediation rule).
  const candidatesByCourse = new Map<string, CandidateValue[]>();
  for (const e of enrollments) {
    const list = candidatesByCourse.get(e.courseId);
    const entry = {
      userId: e.userId,
      ownValue: e.completedAt,
      matchValue: e.completedAt ?? e.updatedAt,
    };
    if (list) list.push(entry);
    else candidatesByCourse.set(e.courseId, [entry]);
  }
  // One candidate per learner per quiz — their OWN earliest passing attempt,
  // matching fillMissingEvidenceMetadata's own semantics (first-seen wins,
  // orderBy completedAt asc). QuizAttempt.completedAt is a required
  // (non-nullable) column, so ownValue and matchValue are always the same.
  const candidatesByQuiz = new Map<string, CandidateValue[]>();
  const seenLearnerQuiz = new Set<string>();
  for (const a of attempts) {
    const seenKey = learnerSourceKey(a.userId, a.quizId);
    if (seenLearnerQuiz.has(seenKey)) continue;
    seenLearnerQuiz.add(seenKey);
    const list = candidatesByQuiz.get(a.quizId);
    const entry = { userId: a.userId, ownValue: a.completedAt, matchValue: a.completedAt };
    if (list) list.push(entry);
    else candidatesByQuiz.set(a.quizId, [entry]);
  }

  async function process(
    evidenceId: string,
    userId: string,
    skillId: string,
    sourceType: "Course" | "Quiz",
    sourceId: string | null,
    occurredAt: Date | null,
    candidates: Map<string, CandidateValue[]>
  ) {
    if (!sourceId || !occurredAt) {
      report.skipped += 1;
      return;
    }
    const group = candidates.get(sourceId) ?? [];
    const own = group.find((c) => c.userId === userId)?.ownValue ?? null;
    const others = group.filter((c) => c.userId !== userId).map((c) => c.matchValue);

    const outcome = await classifyAndRepairOne(
      tenantId,
      userId,
      skillId,
      evidenceId,
      sourceType,
      sourceId,
      occurredAt,
      own,
      others
    );
    switch (outcome.kind) {
      case "repaired":
        report.repaired += 1;
        report.repairedRecords.push(outcome.record);
        break;
      case "ambiguous":
        report.ambiguous += 1;
        report.ambiguousEvidenceIds.push(evidenceId);
        if (outcome.reason === "NO_OWN_SOURCE") report.ambiguousNoOwnSource += 1;
        else report.ambiguousUnattributable += 1;
        break;
      case "correct":
        report.alreadyCorrect += 1;
        break;
      case "stale":
        // A genuine concurrent write raced this classification. Counted
        // separately from repaired/ambiguous/correct — none of those
        // buckets actually happened for this row on this call — so
        // `rowsChecked = repaired + ambiguous + alreadyCorrect + stale +
        // skipped` always reconciles exactly. Safe to leave for the next
        // run, which re-reads and re-classifies fresh.
        report.stale += 1;
        break;
    }
  }

  for (const e of courseEvidence) {
    await process(
      e.id,
      e.userId,
      e.skillId,
      "Course",
      e.sourceId,
      e.occurredAt,
      candidatesByCourse
    );
  }
  for (const e of quizEvidence) {
    await process(e.id, e.userId, e.skillId, "Quiz", e.sourceId, e.occurredAt, candidatesByQuiz);
  }

  return report;
}

export type OccurredAtRemediationTotals = {
  tenants: number;
  rowsChecked: number;
  repaired: number;
  ambiguous: number;
  alreadyCorrect: number;
};

/** Runs `remediateOccurredAtMisattribution` independently per tenant and folds the results. */
export async function remediateOccurredAtMisattributionAllTenants(): Promise<{
  perTenant: OccurredAtRemediationReport[];
  totals: OccurredAtRemediationTotals;
}> {
  const tenants = await db.tenant.findMany({ select: { id: true }, orderBy: { id: "asc" } });
  const perTenant: OccurredAtRemediationReport[] = [];
  for (const tenant of tenants) {
    perTenant.push(await remediateOccurredAtMisattribution(tenant.id));
  }
  const totals = perTenant.reduce<OccurredAtRemediationTotals>(
    (acc, r) => ({
      tenants: acc.tenants + 1,
      rowsChecked: acc.rowsChecked + r.rowsChecked,
      repaired: acc.repaired + r.repaired,
      ambiguous: acc.ambiguous + r.ambiguous,
      alreadyCorrect: acc.alreadyCorrect + r.alreadyCorrect,
    }),
    { tenants: 0, rowsChecked: 0, repaired: 0, ambiguous: 0, alreadyCorrect: 0 }
  );
  return { perTenant, totals };
}
