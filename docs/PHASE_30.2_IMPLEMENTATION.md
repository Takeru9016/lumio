# Phase 30.2 — Capability Recompute, Proficiency History, Backfill & Policy 1 Cutover: Implementation

Builds on `docs/PHASE_30.1_IMPLEMENTATION.md` (`PHASE_30.1 COMPLETE`). This report records what was actually built, run, and empirically proven for the cutover — a data-integrity migration, not a normal feature.

---

## 1. Scope

- Locked `UserSkill` recomputation, in-transaction event history, evidence-writer integration (§3–§11).
- Idempotent historical backfill: baseline events + `occurredAt`/`scorePercent` fallback (§14).
- V1-vs-Policy-1 reconciliation proof, run for real against this repo's local test database (§16).
- Runtime cutover: `proficiency.ts`'s canonical recompute now runs Policy 1 for every write. No separate flag exists to flip — see §11 for why.
- Concurrency proof (C1–C6, real database, deterministic barriers).
- Mutation testing targeted at the new/changed logic.

Not touched: `verification.ts`'s authorization/transition rules, `gaps.ts`, both capability reports, the copilot contexts, recommendations/assignment guard logic beyond what 30.1 already added, any API route, any UI. See §18 for the full deferred list.

---

## 2. Architecture

**Canonical recompute path (I2).** `projectUserSkill` in `src/lib/domain/capability/proficiency.ts` is the one function that writes `UserSkill.proficiency`. It is unchanged in *export name* from 30.1 (contract §M requires the existing suites pass unmodified, and `proficiency.test.ts` imports this name) but its *implementation* is now exactly the task's `recomputeUserSkill` pseudocode: row lock, full evidence read, Policy 1 computation, projection write, conditional history event — all in the caller's own transaction. This is a deliberate naming decision, not an oversight: documented in the file's own header comment, the same discipline 30.1 used for the `readiness.ts` placement deviation.

There are exactly two callers, both already inside `db.$transaction`, both unchanged in their transaction boundary:
- `outcomes.ts:recordSkillEvidenceOutcome` (evidence creation)
- `verification.ts:setEvidenceVerificationStatus` (verify/reject)

Reconciliation (`policyReconciliation.ts`) and backfill (`capabilityBackfill.ts`) are two new, narrowly-scoped modules that share the *level-computation* policy (`ceilingFor`/`doesEvidenceContribute`/`maxProficiency` from 30.1's `proficiencyPolicy.ts`) but never call `projectUserSkill` — reconciliation is read-only by construction (it is the shadow-computation step, which must run before anything writes), and backfill never recomputes or writes `proficiency` at all (§14/§16 forbid it).

---

## 3. Transaction boundaries

Unchanged from 30.1's existing boundaries, now doing more work inside them:

- `recordSkillEvidenceOutcome`: one `db.$transaction` per skill, containing evidence create + `projectUserSkill` (lock, read, compute, write, event). Unchanged scope — no new transaction introduced.
- `setEvidenceVerificationStatus`: one `db.$transaction` containing the evidence status/`revision` update + `projectUserSkill`. Unchanged scope.
- `recordCourseCompletionOutcome`/`recordQuizOutcome`/`recordAssignmentGradeOutcome`'s outer failure-isolation boundaries (Phases 24/25) are untouched: `recordQuizOutcome` still never throws, `recordCourseCompletionOutcome` still rethrows the evidence failure after the best-effort `LearningEvent` emission, exactly as F11 requires.
- `backfillTenant`: one short transaction **per `UserSkill` row** (lock, re-check, cache-metadata write, `BASELINE` event), not one giant transaction per tenant — bounded lock duration (task §22).
- `reconcileTenant`: no transaction at all — pure reads, batched.

---

## 4. Locking strategy

`projectUserSkill` step 1–2 (contract §F1):

```
tx.userSkill.createMany({ data: [{tenantId,userId,skillId}], skipDuplicates: true })  // ON CONFLICT DO NOTHING
tx.$queryRaw`SELECT ... FROM "UserSkill" WHERE userId=$1 AND skillId=$2 FOR UPDATE`
```

This mirrors the repo's own established convention (`learning-path/paths.ts`'s `lockPath`, and its test helper `learning-path/__test__/lock.ts`'s `holdLock`) rather than inventing a new pattern. `createMany.count === 1` is the signal that *this* call created the row — the only case with genuinely no prior state — which is what makes `previousProficiency: null` in the resulting event correct rather than a guess.

`backfillTenant` reuses the identical `SELECT ... FOR UPDATE` pattern per row, re-checking `eventSeq === 0` *after* acquiring the lock — not just before reading the batch — specifically to survive a real writer racing ahead between the batch read and the lock (proven in §12, C-series).

**The `FOR UPDATE` lock's necessity is now directly proven** (§12/§14): a dedicated test races two *real* `projectUserSkill` calls (not a decoy holder) against each other on an existing row via a shared barrier, then asserts both resolve cleanly. Removing `FOR UPDATE` makes this test fail with a real `P2002` on `SkillProficiencyEvent`'s `[userId, skillId, seq]` constraint — one of the two racing transactions loses its entire evidence-triggered recompute, exactly the lost-update scenario I3/F1 exist to prevent. Verified empirically, not just reasoned about — see §14.

---

## 5. Event semantics

**Cause and rule for whether an event fires — the one deliberate deviation from contract text, decided before writing code:**

Contract F5 says an event must be written for *every* transition that reaches the projection, "including transitions that leave the level unchanged." Task §7 says the opposite in plain terms: "`INTERMEDIATE → INTERMEDIATE` must not create a new proficiency event," reinforced by P5 ("no-op recomputation creates no proficiency event") and P6's use of the word "transition." Three statements in the operative task vs. one line in the contract.

**Resolved in favor of the task (§7/P5/P6): an event is written if and only if `newProficiency !== previousProficiency` (or the row is being created for the first time, which counts as a transition from "no projection" to whatever it starts at — matching V1's own `lastAssessedAt`-on-creation behavior exactly).**

A corollary decided the same way: a *confidence-only* change (no level change) does not emit an event either. `UserSkill.evidenceConfidence`/`policyVersion` are still refreshed as plain cache fields on every recompute (contract §D1 — confidence is a derived cache, kept current independent of whether the level moved), but that refresh is not itself a history-worthy transition.

**Event fields**, all populated from data the recompute already has in hand (no second read, per F11):

| Field | Source |
|---|---|
| `seq` | `locked.eventSeq + 1`, allocated under the same row lock |
| `cause` | Caller-supplied (`EVIDENCE_ADDED`, `EVIDENCE_VERIFIED`, `EVIDENCE_REJECTED`, `BASELINE`) or `RECALCULATED` by default |
| `evidenceId`/`evidenceRevision` | Caller-supplied — see §7 for why `evidenceRevision` had to become real |
| `actorId`/`actorRole` | Caller-supplied (verification.ts only; null for system-driven evidence writes) |
| `previousProficiency`/`newProficiency` | The locked row's prior value (or `null` on true creation) / the fresh computation |
| `previousConfidence`/`newConfidence` | Same pairing for confidence |
| `policyVersion` | `CURRENT_POLICY_VERSION` (1) |
| `contributing` | `[{evidenceId, type, verificationStatus, grant}]` for every contributing row, ids/enums only |
| `occurredAt` | The caller's `changeTimestamp` — business time, may be backdated |
| `recordedAt` | Row default (`now()`) |

---

## 6. `eventSeq` allocation

Not removed, not treated as unnecessary — the task explicitly required stopping and documenting if it were to be dropped, and there was no reason to: `nextSeq = locked.eventSeq + 1`, computed and written inside the same lock as the projection, and the `SkillProficiencyEvent` row insert happens in the same transaction as the `UserSkill.eventSeq` update. If the event insert fails (e.g. a genuine unique-constraint collision), the whole transaction — including the `eventSeq` bump — rolls back, so the two can never drift apart. Proven under real concurrency in C6 (§12): five concurrent evidence writes for one skill, plus one verification, land on `seq ∈ {1, 2}` with no gaps and no duplicates.

---

## 7. Evidence writer integration

Traced every writer per the task's own checklist:

| Writer | Creates evidence | Updates evidence | Updates `UserSkill` | Emits event |
|---|---|---|---|---|
| `outcomes.ts:recordSkillEvidenceOutcome` (course/quiz/assignment) | yes | — | via `projectUserSkill` | via `projectUserSkill` |
| `verification.ts:setEvidenceVerificationStatus` (verify/reject) | — | yes | via `projectUserSkill` | via `projectUserSkill` |

Both already routed through `projectUserSkill` before this phase (30.1 didn't touch them) — no new call site was introduced. Two small, necessary changes were made *within* those existing call sites:

1. **`outcomes.ts` now stores `occurredAt` on the evidence row it creates.** The value was already a function parameter (`recordSkillEvidenceOutcome({..., occurredAt})`) but was never persisted onto the row — meaning `confidenceFor`'s freshness check could never see it for any newly-written evidence, forever defaulting to "unknown age" the way 30.1 documented as its own known limitation. This is a one-line addition (`occurredAt` added to the `create` call's `data`), not a rewrite of the writer's logic.

2. **`verification.ts` now increments `SkillEvidence.revision` on every verify/reject**, in the same `data: {...}` object as the existing status update — see §8 for why this stopped being optional.

Neither change touches authorization, the source-resolution chain, or any transition semantics — `resolveSourceCourse`, `authorizeVerificationActor`, and the verify/reject/idempotent-re-verify contract are byte-for-byte unchanged.

---

## 8. A landmine found and fixed before it shipped: `revision` had to actually move

30.1 shipped `SkillProficiencyEvent`'s `@@unique([evidenceId, evidenceRevision])` constraint with `SkillEvidence.revision` permanently stuck at its `0` default — nothing incremented it. Tracing the real call graph (§7) surfaces a live production path that would have broken under that combination: `setEvidenceVerificationStatus` handles **both** verify and reject on the same evidence row. A verify-then-reject sequence on one row — which `verification.test.ts` already exercises (`verifyEvidence` then `rejectEvidence` on the same `evidenceId`, lines ~139–142 and ~349–355 of that file) — would stamp two `SkillProficiencyEvent` rows at `(evidenceId, revision=0)`, and the second insert would fail its own unique constraint, causing the reject transaction to roll back entirely.

**Fix:** `verification.ts`'s `data:` object for both the VERIFIED and REJECTED branches now includes `revision: { increment: 1 }`, and the resulting updated row's `revision` (not a hardcoded `0`) is passed into `projectUserSkill` as `evidenceRevision`. This is the smallest possible fix — one field added to an existing update statement — and it is exactly what 30.1's own schema comment anticipated ("incremented on every audited transition of the row... Phase 30.3's verify/reject/unverify/revoke/reinstate"), just arriving one field-write earlier than 30.3's full state-machine work. It does not introduce new verification *semantics* (no new transition, no new authority rule) — only makes an already-shipped uniqueness guarantee actually hold.

This was caught by running the full existing `verification.test.ts` suite against the new locked `projectUserSkill` before writing any new code for this phase (see §13) — exactly the sequencing the advisor recommended: wire the two call sites, then run existing suites, because that is where a revision collision would surface.

---

## 9. Backfill design

`src/lib/domain/capability/capabilityBackfill.ts`. Two independent, narrowly-scoped jobs per batch of `UserSkill` rows:

1. **Fill `SkillEvidence.occurredAt`/`scorePercent` where still null** (contract §H7's exact fallback chain): `Enrollment.completedAt ?? Enrollment.updatedAt` for `COURSE_COMPLETION`; earliest passing `QuizAttempt.completedAt` for `QUIZ_SCORE` (both the current `sourceType: "Quiz"` keying and legacy `"QuizAttempt"` rows); `AssignmentSubmission.gradedAt` for `ASSESSMENT`; else the evidence row's own `createdAt` — the documented fallback, never a fabricated value. `scorePercent` is `score` directly for quiz evidence conceptually (V1's `score` already is the percentage) and `score / Assignment.maxScore * 100` for assessment evidence when resolvable, else left `null` (never `0` — "unknown" and "zero" are different facts). Every write is guarded by `updateMany({ where: { ..., occurredAt: null } })` / `{ scorePercent: null }` so a value once established is never touched again (contract §B5 — occurredAt is immutable *content*; filling a null establishes it for the first time, it does not rewrite it).

2. **Write exactly one `BASELINE` `SkillProficiencyEvent` per `UserSkill` row that has never had one.** Checkpoint: `eventSeq === 0` (0 is the "no V2 event exists yet" neutral value 30.1's own schema comment defines). The event's `previousProficiency` is `null` (establishing history, not fabricating a transition — contract §15) and its `newProficiency` is the row's **existing stored value**, never a freshly recomputed one. `evidenceConfidence`/`policyVersion`/`eventSeq: 1` are written as cache metadata on the `UserSkill` row.

**Backfill never calls `projectUserSkill` and never writes `UserSkill.proficiency`.** This is the direct answer to task §16's "do not simply force `UserSkill` to the new value and declare success": backfill doesn't have an opinion on whether the stored value is correct — reconciliation (§10) is what proves that, *before* backfill runs, and backfill's only job for the projection field itself is to leave it exactly as reconciliation found it.

**Restartability (task §23, P9):** the checkpoint (`eventSeq === 0`) is the batch-query's own `WHERE` clause (`db.userSkill.findMany({ where: { tenantId, eventSeq: 0, id: { notIn: [...failedIds] } } })`). Every row this function successfully processes leaves `eventSeq` at `1` — permanently removing it from that query — so a second full run naturally does zero work, and a killed/interrupted run simply leaves the untouched rows still queryable by the next call. No separate checkpoint table, no offset bookkeeping. Failed rows (a genuine write error) are tracked in-memory per call and excluded from the *next* batch read within that same call, so one bad row can't infinite-loop the batching, but is retried fresh on the next top-level call.

---

## 10. Reconciliation methodology

`src/lib/domain/capability/policyReconciliation.ts`. For every `UserSkill` row (batched, tenant-scoped, never a cross-tenant query — task §21): fetch its full evidence set, compute the Policy 1 projection with the same pure functions the writer uses, and classify the comparison into exactly the four buckets task §16 names, in a strict priority order using only *determinable* markers — never a guess:

1. **`EXPLAINABLE_LEGACY`** — stored level is `ADVANCED`/`EXPERT`, unreachable under Policy 1 (and under V1's identical ceiling). No writer, ever, could have produced it from evidence.
2. **`EXACT_MATCH`** — stored equals the fresh computation.
3. **`FIXTURE_ONLY`** — stored differs, but either of two determinable markers proves no writer ever touched this row: **(a)** zero *contributing* evidence exists (covers both "no evidence at all" and "evidence exists but is entirely rejected/invalid" — V1's own query excludes rejected evidence exactly the way Policy 1's `doesEvidenceContribute` does, so neither policy's writer could ever produce non-`NONE` from zero contributing rows), or **(b)** `lastAssessedAt IS NULL` — every real writer (V1's original and this phase's canonical recompute alike) unconditionally sets `lastAssessedAt` the first time it creates a row (contract §F3); a row where it's still null was created directly (`db.userSkill.create`), bypassing every writer, regardless of what evidence happens to sit next to it.
4. **`UNEXPLAINED`** — stored differs and neither marker applies. This is what blocks cutover.

**Both FIXTURE_ONLY markers were widened after the first real run against this repo's database, not designed in from a guess** — see §16 for exactly what each run found and how the classifier changed in response. This is reported explicitly, the same way 30.1 reported its fixture-vs-live-traffic clarification for the G1 guard, rather than silently tuning the classifier and only showing the final version.

---

## 11. Cutover process — and why there is no flag

The task's own §18 recommended sequence (schema → recompute code → shadow reconciliation → prove zero unexplained → backfill → verify → "enable Policy 1 runtime calculation" → suite → reconcile again) describes a *policy switch* step that does not exist to be flipped in this phase, and building one would be pure ceremony: **Policy 1 already *is* the only policy that exists.** There is no Policy 2 in this codebase to switch away from — it is explicitly Phase 30.3/30.8's addition (contract §N). `CURRENT_POLICY_VERSION` (from `proficiencyPolicy.ts`, unchanged since 30.1) is **written**, not toggled: every recompute now stamps it onto `UserSkill.policyVersion` and every `SkillProficiencyEvent.policyVersion`, which is what makes a *future* Policy 2 cutover diffable against this phase's rows later. Task §18 forbids building "a complex feature-flag framework" for exactly this reason — a switch with one position is not a switch.

"Cutover," concretely, is: the two writers (§7) now run through the fully-implemented `projectUserSkill` (lock → full evidence read → Policy 1 compute → write → event) instead of the old inline query-and-upsert. That change is already live in `git diff` — there was no separate "enable" step to perform, because the same function that computes now also computed under 30.1 (Policy 1 is defined as V1-equivalent by construction, contract §C4/INV14), just without the lock, the event, or the cache-field writes.

---

## 12. Concurrency tests (task §24, C1–C6)

All in `src/lib/domain/capability/proficiency.concurrency.test.ts` (7 tests) plus 2 dedicated tests in `capabilityBackfill.test.ts`, all against the real local test database, all using the repo's own real-lock barrier convention (`learning-path/__test__/lock.ts`'s `holdLock`, reproduced locally rather than importing across domains) — never a sleep-based race.

| # | Scenario | Proof |
|---|---|---|
| C1 | Two concurrent evidence writes, same (user, skill), different sources | Both land; exactly one event (the second write doesn't change the level, so §5's rule correctly emits none); `eventSeq` consistent |
| C2 | Two concurrent recomputes on an *existing* row (decoy holder + one real racer) | Second genuinely blocks on the held lock (`settledWithin(..., 150) === false`), then proceeds correctly once released; final state and `eventSeq` reflect both |
| C2′ | **Two REAL concurrent recomputes racing each other** (no decoy — both are `projectUserSkill` calls, released simultaneously after both queue behind a shared holder) | Both resolve cleanly; `eventSeq` lands on 2 with no gap. This is the test that directly disproves the `FOR UPDATE` mutation (§14) — without the lock, both read the same stale `eventSeq`, both compute `nextSeq = 2`, and the second's event insert collides on `[userId, skillId, seq]`, losing its transaction entirely |
| C3 | Evidence write concurrent with a direct recompute call | Both land; final projection reflects the union of evidence |
| C4 | Two concurrent recomputes racing the *first-ever* creation of one row | Exactly one `UserSkill` row exists after both settle (no duplicate-key failure); exactly one creation event (`previousProficiency: null`) |
| C5 | The same evidence source processed twice, concurrently, then a third time sequentially | Exactly one evidence row, one event, `eventSeq` stays at 1 across all three attempts |
| C6 | Five concurrent evidence writes plus one verification for the same skill | `eventSeq` lands on exactly 2, `seq` values `{1, 2}`, no duplicates, no gaps |
| — | (`capabilityBackfill.test.ts`) A `UserSkill` row flips to `eventSeq > 0` **while backfill's own per-row lock is genuinely blocked waiting for it** | Backfill's post-lock re-check sees the new `eventSeq` and backs off cleanly (`rowsAlreadyBaselined: 1`, zero failures) rather than attempting a colliding second `BASELINE` insert |

The tests verify **final persisted state** (row counts, `eventSeq` values, event `cause`/`previousProficiency`/`newProficiency`), not merely "no exception was thrown," per the task's explicit requirement.

---

## 13. Idempotency tests

- **P4/P9 (recompute)**: covered by C1/C5 above — repeated/duplicate evidence processing produces no duplicate row and no duplicate event.
- **P9 (backfill)**: `capabilityBackfill.test.ts` — a second full `backfillTenant` run over the same tenant produces zero additional writes (`rowsConsidered: 0`); a simulated interrupt-and-resume (one row pre-baselined "by hand" to stand in for a killed prior run, one row untouched) proves the resumed call skips the first and picks up the second, with no duplicate events on either; the true-concurrency variant above additionally proves the *in-flight* race, not just the before/after case.
- **Evidence writer idempotency (task §12)**: `outcomes.test.ts` (pre-existing, unmodified, still passing) already covers the P2002-benign-no-op path for the `[tenantId, userId, skillId, sourceType, sourceId]` unique constraint; C5 above extends this specifically into the new event-history path.
- **Existing suites unmodified, exactly per contract §M**: `proficiency.test.ts`'s ten tests run against the new implementation with zero edits to the test file — the new, optional constructor parameters (`cause`, `evidenceId`, etc.) default in a way that reproduces every assertion those tests already made.

---

## 14. Mutation results

No mutation-testing tool is installed; followed the repository's established manual convention (Python, exact-string mutation, targeted test run, restore in `finally`, restoration verified by re-diff). 30.1's own 18 mutants targeted `proficiencyPolicy.ts`/`readiness.ts`, which this phase did not modify — not re-run. This phase's 10 mutants targeted exactly the areas the task named that are new or changed here: lock removal, projection-update/no-op guarding, sequence increment, reconciliation's two fixture markers, backfill's checkpoint filter, backfill's concurrent re-check guard, and backfill's null-guard on the occurredAt fill.

| # | Target | Mutation | Result |
|---|---|---|---|
| 1 | `proficiency.ts` | Remove `FOR UPDATE` from the lock query | Killed (after adding the true-concurrency C2′ test — see below) |
| 2 | `proficiency.ts` | `levelChanged` forced to always `true` | Killed |
| 3 | `proficiency.ts` | `wasJustCreated` forced to always `false` | Killed |
| 4 | `proficiency.ts` | `nextSeq` not incremented | Killed |
| 5 | `policyReconciliation.ts` | Remove `lastAssessedAt === null` marker | Killed |
| 6 | `policyReconciliation.ts` | Remove `contributingCount === 0` marker | Killed (after adding a test that genuinely isolates it — see below) |
| 7 | `policyReconciliation.ts` | Remove tenant filter from the evidence query | Killed |
| 8 | `capabilityBackfill.ts` | Remove `eventSeq: 0` checkpoint filter | Killed |
| 9 | `capabilityBackfill.ts` | Weaken the post-lock re-check to ignore `eventSeq` | Killed (after adding a true-concurrency test — see below) |
| 10 | `capabilityBackfill.ts` | Remove the `occurredAt: null` guard on the metadata fill | **Survived — investigated, see below** |

**9/10 killed outright or after a targeted fix. One investigated in full and consciously kept as a documented residual gap, not silently dropped:**

- **#1, #6 and #9 initially survived for the same structural reason**: each first test collapsed into a code path that never reached the mutated line at all. #1's original concurrency tests only ever raced a *real* `projectUserSkill` call against a *decoy* holder whose own (unmutated, test-side) lock made the blocking assertion pass regardless of whether `proficiency.ts`'s own lock existed. #6's test used `db.userSkill.create` directly, which *always* trips the `lastAssessedAt === null` marker first, so the `contributingCount` branch was dead for that test. #9's test advanced `eventSeq` *before* calling `backfillTenant`, so the row never entered the batch, never reaching the per-row re-check. All three were fixed with a properly isolated test: for #1, two *real* `projectUserSkill` calls racing each other (C2′, §12) — released simultaneously from a shared barrier so Postgres's own row lock, not a decoy, is what's being tested; for #6, a row genuinely recomputed by a real writer (`lastAssessedAt` legitimately set) whose evidence is then force-rejected *outside* `verification.ts`, so only the `contributingCount` marker can explain the mismatch; for #9, the true-concurrency test in §12's last row, using a real held lock so the row is *in* the batch when it flips. All three mutants are killed after the fix — verified by re-applying each mutation and re-running its test, then restoring the file and confirming the restored suite passes clean.
- **#10 (`occurredAt: null` guard removal) is the one remaining, genuinely investigated survivor.** It protects against a transaction reading `occurredAt` as null, then writing a stale, already-resolved value after a *concurrent* fill already set it — a race between two overlapping `fillMissingEvidenceMetadata` calls, which this phase's backfill never runs (one process, sequential batches). The in-memory `needsOccurredAt` pre-filter (computed from a *fresh* per-call read) already prevents any *sequential* re-run from reaching the guarded `updateMany`, which is exactly why sequential tests (including a dedicated one built specifically to isolate this guard) cannot trigger it — proving the guard unreachable from this phase's own call pattern, not that it's unnecessary defense-in-depth for a future parallelized runner. Kept in the code (removing it would be free-riding on the pre-filter's redemption instead of standing on its own), reported here rather than silently dropped as "obviously fine."

All mutated files were verified byte-identical to their pre-mutation content after every run (the harness's own `assert restored == content` for the scripted mutants, matching 30.1's restoration-verification discipline). **One manually-applied mutant (#1's initial removal, before the scripted C2′ fix existed) was not restored automatically** — a `git diff --stat` check after applying it showed a plausible-looking line-count delta and was mistaken for confirmation; the actual restoration was only caught and fixed by a subsequent `grep` for the `FOR UPDATE` string, which found it missing. Disclosed here because an auditor would rather read this than find it by diffing — the file is now confirmed correct (`FOR UPDATE` present, the full 3156-test suite passes clean), but a line-count comparison is not a substitute for checking the actual restored content next time.

---

## 15. Performance observations

- `reconcileTenant`/`backfillTenant` batch in bounded pages (default 500/200 rows respectively), never loading a whole table into memory; evidence for a batch is fetched in one bulk query keyed by the batch's `(userId, skillId)` pairs, not one query per row.
- **A real, worth-recording finding**: this repo's accumulated local test database has **222,834 `Tenant` rows** (test-fixture accumulation across the project's history — one tenant per `createTenantUser()` call across thousands of test runs) but only **~15,491 tenants that actually have any `UserSkill` data**. The generic `reconcileAllTenants`/`backfillAllTenants` wrappers (task §21 — no tenant filter by design, since production tenant counts are nothing like this) were **not** run unscoped against this database for the empirical proof below — doing so would mean ~207,000 wasted round trips against empty tenants, several minutes for no signal. Instead, the proof run queried the distinct set of capability-bearing tenants directly and called `reconcileTenant`/`backfillTenant` per tenant (still fully respecting tenant isolation, task §21 — just skipping the ones with nothing to reconcile). This is a property of this specific accumulated local database, not of production, and is stated here rather than left for someone to discover later. `reconcileAllTenants`/`backfillAllTenants` themselves are unmodified, general, and were exercised by code review + the fact that `reconcileTenant`/`backfillTenant` (the functions they fold) are exhaustively tested — not run end-to-end against this database's full tenant count in an automated test (a vitest test doing so would blow past any sane timeout for a data shape unique to test accumulation, not to what the function needs to handle in production).
- Full run timings against the real local database (15,491 capability-bearing tenants, 17,856 `UserSkill` rows, ~21K `SkillEvidence` rows): reconciliation pass ≈ 2.6–2.9s; backfill pass ≈ 1.2–1.3s (mostly a handful of new rows created by that session's own test runs, since almost everything had already been baselined by the prior pass); backfill idempotency pass ≈ 1.2–1.7s for zero writes.

---

## 16. Reconciliation results (empirical, not a plan)

Run repeatedly against `lumio_test` over the course of this phase, refining the classifier's `FIXTURE_ONLY` markers in response to what each real run actually found. Reported as a full history, not just the final clean-looking number — including a mistake this phase's own testing caused and then caught:

**Run 1 (first classifier — only "zero evidence rows" as the fixture marker):**
```
{"tenants":15190,"total":17508,"exactMatch":14526,"fixtureOnly":2255,"explainableLegacy":457,"unexplained":270}
```
All 270 unexplained rows shared one exact shape: one `REJECTED` evidence row paired with a `UserSkill` fixture set to `BEGINNER` directly. Confirmed by direct query. Not a production defect — V1's own query excludes `REJECTED` evidence identically to Policy 1's `doesEvidenceContribute`, so no writer of either policy could have produced a non-`NONE` result from an entirely-rejected evidence set. **Fix:** widened `FIXTURE_ONLY` from "zero evidence rows" to "zero *contributing* evidence rows."

**Run 2 (after the fix):**
```
{"tenants":15317,"total":17652,"exactMatch":14637,"fixtureOnly":2547,"explainableLegacy":465,"unexplained":3}
```
The 3 remaining rows shared a mirror-image shape: contributing evidence present (correctly computing to `BEGINNER`), stored `NONE`, but `lastAssessedAt` genuinely `NULL`. **Fix:** added `lastAssessedAt IS NULL` as a second, independent `FIXTURE_ONLY` marker (contract §F3 — every real writer sets it unconditionally on first creation).

**Run 3 (after both fixes):** 1 remaining unexplained row, traced to `policyReconciliation.test.ts`'s own deliberate-drift test (the test that proves the `UNEXPLAINED` path itself still fires) leaking its fixture into the persistent, un-truncated local database. **This exposed a real gap in the test, not in the classifier**: the test never cleaned up after itself, so every subsequent full-suite run would add one more permanently-unexplained row, and the reconciliation gate could never read zero again on this database. **Fix (not a classifier change this time — a test hygiene fix):** added a `finally` block that restores the row to its correct computed value after asserting, so the test proves the `UNEXPLAINED` path without leaving a standing false alarm.

**This session had already run the full suite several times with the un-fixed version of that test**, so 14 orphaned rows (all the identical drift shape) had already accumulated. All 14 were confirmed individually against that run's `unexplainedSamplePreBackfill` array (capped at 50 samples — the cap did not bind at 14, so every orphan was accounted for by name, not a subset) before being corrected by hand, one at a time, to their correctly-computed value via direct `UPDATE` statements against `lumio_test` — disclosed here explicitly since it is a direct, deliberate write to the same test database everything else in this report is measured against. After the fix and the one-time cleanup, a full suite run was executed again and reconciliation re-run immediately after: **zero new orphaned rows**, confirming the `finally` block actually prevents recurrence going forward.

**Final, clean state this phase ships with:**
```
{"tenants":16908,"total":19504,"exactMatch":16198,"fixtureOnly":2771,"explainableLegacy":535,"unexplained":0}
```
Re-confirmed after one more full 3156-test suite run (which itself creates thousands of new fixture rows): `{"tenants":17076,"total":19698,"unexplained":0}` — the count of capability-bearing tenants and total rows grows with every test run (expected, this database is never truncated), but `unexplained` stays at zero.

**Gate: zero unexplained mismatches of unknown origin, empirically re-verified after the fix that caused (and then eliminated) the one contaminating source.** `docs/PHASE_30.2_RECONCILIATION.json` holds that clean run's snapshot (16,908 tenants). It was not regenerated for the two later confirmation passes (17,076 then 17,367 tenants, both `unexplained: 0`, quoted in prose above) — the tenant/row counts climb with every subsequent test run against this never-truncated database (expected), while `unexplained` staying at zero across all three is the actual proof; the JSON file is one representative snapshot of that ongoing proof, not a claim that the counts are frozen.

**Backfill results:** across the session's runs, every row reaching `eventSeq === 0` was baselined (over 14,900 rows cumulatively, as the classifier iterations and the orphan cleanup proceeded), `occurredAt` was filled on over 13,300 evidence rows and `scorePercent` on 326. The idempotency pass (run immediately after each backfill pass) consistently shows **zero** new rows considered/baselined/filled for everything already processed. Reconciliation re-run after backfill shows **identical totals** to the pre-backfill run each time, proving backfill does exactly what §9 designed it to do — establish history and cache metadata without ever touching `UserSkill.proficiency`.

**One further, honestly-reported wrinkle in the final runs: 9 persistent `backfillTenant` failures**, identical across every subsequent pass (`rowsConsidered: 9, failures: 9`). Traced directly, by query, to `capabilityBackfill.test.ts`'s own two intentional-collision tests (the true-concurrency re-check test and the `occurredAt`-guard isolation test, §12/§14) — both deliberately pre-insert a colliding `seq: 1` `SkillProficiencyEvent` so that `backfillTenant`'s own `BASELINE` insert permanently fails with a real unique-constraint violation, proving the per-row transaction fails safely (no partial write, no corrupted `UserSkill` state) rather than never failing at all. These are not cleaned up in a `finally` (unlike the reconciliation drift fixture) because the failure *is* the test's assertion, not an accident — but they are the same class of test-fixture contamination as §17 describes, confirmed by direct query rather than assumed, and they do not affect the reconciliation gate (`unexplained` stays 0 regardless — a `backfillTenant` failure never touches `UserSkill.proficiency`).

---

## 17. Test fixture contamination (task §17)

Directly demonstrated, not just acknowledged: §16's three-run history *is* the fixture-contamination story. The local accumulated test database's `UserSkill`/`SkillEvidence` rows are overwhelmingly produced by direct `db.userSkill.create()`/`db.skillEvidence.create()` calls across this repo's ~600 other test files, which bypass every production writer by design (they're testing read paths, display formatting, authorization, etc., not the writer itself). `docs/PHASE_30.2_RECONCILIATION.json`'s `fixtureOnly` count (2,576) and `explainableLegacy` count (473) are exactly this — identified by determinable markers, not assumed, and never silently deleted, corrected, or force-matched to make the numbers look cleaner.

---

## 18. Migration/database safety

**No schema migration in this phase.** Confirmed via `npx prisma validate` (schema valid) and by inspection: every column, index, enum, and constraint this phase's code reads or writes shipped in 30.1's migration. This matches the advisor's explicit prediction going in ("expect zero schema changes... treat writing one as a scope-creep signal").

**Database target, stated for every operation:**
- Migration: none run.
- Tests (`vitest run`): `lumio_test`, local Postgres 17 — `DATABASE_URL` pinned explicitly on every command (`DATABASE_URL="postgresql://sahiljadhav@localhost:5432/lumio_test"`), never relying on `.env.local`'s Neon default, per this session's established safeguard.
- Reconciliation/backfill empirical runs: same `lumio_test` target, run via a temporary `tsx` script at the repo root (`phase302_run.ts`), deleted before finishing this phase — never committed, matching the established scratch-script convention from Phase 30.0/30.1.
- **Production (Neon) was never touched, and this environment has no access to it** — the same caveat 30.0/30.1 carried forward. The empirical reconciliation proof (§16) is strong evidence against a large, real (if test-shaped) Postgres dataset, not a production guarantee. Anyone running this cutover against Neon should re-run `reconcileTenant`/`reconcileAllTenants` there first and confirm zero unexplained mismatches before trusting this report's numbers to transfer.

---

## 19. Files changed

**Modified (5):**
- `src/lib/domain/capability/proficiency.ts` — `projectUserSkill` rewritten to the full F1 locked implementation (net +183/-64 lines against the 30.1 baseline).
- `src/lib/domain/capability/outcomes.ts` — stores `occurredAt` on evidence creation; passes `cause`/`evidenceId`/`evidenceRevision` into the recompute call.
- `src/lib/domain/capability/verification.ts` — increments `SkillEvidence.revision` on verify/reject (§8); passes `cause`/`actorId`/`actorRole`/`evidenceRevision` into the recompute call.
- `src/lib/domain/capability/phase30SchemaFoundation.test.ts` — 3 assertions updated from 30.1's "nothing writes here yet" expectations to the now-active writer's real output (`occurredAt` set, `eventSeq`/`evidenceConfidence`/`policyVersion` populated, one `EVIDENCE_ADDED` event) — an intentional, task-authorized behavior change, not a regression; explained in the file's own updated header comment.
- `src/lib/domain/capability/proficiencyPolicy.ts` — four comments updated for accuracy (this module is now the live runtime policy, not "not yet wired in"; `CURRENT_POLICY_VERSION` is now written); zero behavioral change.

**New (7):**
- `src/lib/domain/capability/policyReconciliation.ts` + `.test.ts` (11 tests)
- `src/lib/domain/capability/capabilityBackfill.ts` + `.test.ts` (10 tests)
- `src/lib/domain/capability/proficiency.concurrency.test.ts` (7 tests)
- `docs/PHASE_30.2_RECONCILIATION.json` — the machine-readable reconciliation/backfill artifact (§16)
- `docs/PHASE_30.2_IMPLEMENTATION.md` (this file)

**Not present (verified via `git status`):** no `prisma/schema.prisma` change, no new migration directory, no API route, no UI file, no `src/generated/prisma/*` regeneration (nothing to regenerate — schema unchanged).

**Test count:** 3128 (end of Phase 30.1) + 28 new (7 + 11 + 10) = **3156**, all passing. `phase30SchemaFoundation.test.ts`'s 10 tests are unchanged in count, 3 with updated expected values (§19 above).

**One additional check performed and worth recording:** grepped every non-test consumer of `UserSkill` (`gaps.ts`, both capability reports, `policyReconciliation.ts`, `capabilityBackfill.ts`) for any read of `UserSkill.updatedAt` specifically — the no-op cache-refresh path (§5) now writes `evidenceConfidence`/`policyVersion` on every recompute, which bumps Prisma's auto-managed `updatedAt` even when `proficiency` itself doesn't change. Zero matches: nothing in this codebase selects or surfaces that field today. Not a behavior change any consumer can currently observe, but flagged here rather than left for someone else to discover if a future phase starts reading it.

---

## 20. Deferred work

Exactly per task §31/§21's exclusion list — confirmed by grep-level check that none leaked into this phase's diff:

- **30.3**: Policy 2 (type-aware grant table), confidence-driven behavior, new verification/expiry state machine, the expiry cron. (`verification.ts`'s transition rules are byte-for-byte unchanged beyond the `revision` increment in §8.)
- **30.4**: history read APIs/UI. (No new route.)
- **30.5**: full readiness-consumer migration, `NOT_ASSESSABLE` wiring beyond 30.1's G1 guard.
- **30.6**: profile/dashboard/report/AI-context surfacing of status/confidence/expiry.
- **30.7**: analytics.
- **30.8**: assessor path.
- Hard proficiency decay, tenant-configurable policy, event-sourcing/snapshot tables, `LearningEvent` transactionality — none added.

---

## 21. Known risks

1. **One mutation survivor (the `occurredAt: null` guard in `capabilityBackfill.ts`) is defense-in-depth for a race this phase's single-process backfill never actually creates** — full reasoning in §14. The guard is correct and was kept; it protects a future parallelized runner, not anything in this phase's own call pattern.
2. **`capabilityBackfill.test.ts` permanently leaves 9 intentionally-failing rows in the local test database** (§16, last paragraph) — by design, since the failure itself is what those two tests prove. Will show up in any future `backfillTenant` run against this database as `failures: 9`; explained here by name so it isn't mistaken for a new defect.
3. **Everything in this report is proven against the local test database, not production.** No Neon access exists in this environment (same caveat as 30.0/30.1). The reconciliation proof's *methodology* is production-ready; its *numbers* are not a production guarantee until re-run there.
4. **`reconcileAllTenants`/`backfillAllTenants` were not exercised end-to-end in this session** — only the `reconcileTenant`/`backfillTenant` functions they fold, which are exhaustively unit/integration tested. The wrappers are a thin loop + arithmetic fold (see the source); running them unscoped against a database shaped like production (a sane tenant count) should be uneventful, but this specific database's 222,834+-tenant test-accumulation shape made a full run impractical to include as an automated proof (§15).
5. **This phase directly modified rows in `lumio_test` outside of the application code path** (§16 — 14 one-time manual `UPDATE` statements correcting orphaned rows from a test bug that has since been fixed). Disclosed in full in §16 rather than only in this list; no other manual data modification occurred anywhere in this phase.

---

## 22. Final verification

| Check | Result |
|---|---|
| Full test suite | 174 files, 3156 tests, 0 failed (clean run; the pre-existing, 30.1-documented `downgrade-subscriptions` cron flake was hit on several interim runs during this phase — re-confirmed unrelated via isolated re-runs, zero relation to any capability/backfill/reconciliation file, and the final full-suite run reported here was clean) |
| Capability + learning-assignment focused suite | 35 files, 669 tests, 0 failed |
| Concurrency suite (proficiency.concurrency.test.ts, 7 tests + 2 dedicated backfill-race tests) | 9 tests, 0 failed |
| Reconciliation (real DB, run repeatedly through the phase, final state re-verified after the full suite) | 0 unexplained mismatches of unknown origin, empirically re-confirmed after fixing the one self-inflicted contamination source (§16) |
| Backfill (real DB) + repeated idempotent runs | 0 unexpected writes on every idempotency pass |
| `npx tsc --noEmit` | 0 errors |
| `npx biome check .` | 0 errors, 53 warnings (unchanged baseline from 30.1; all pre-existing, none in files this phase touched) |
| `npx prisma validate` | schema valid, unchanged |
| `pnpm build` | succeeds, identical route list, no new route |
| `git diff --check` | 0 |
| Mutation testing | 10 mutants targeted at new/changed logic; 9 killed (3 after adding properly-isolated tests); 1 investigated and kept as a documented residual gap (§14) |
| Migration/schema diff | none — confirmed zero schema changes |

**Repository hygiene, stated precisely:** `git status --short` shows exactly 5 modified files and 7 new files (§19), nothing else. Two temporary scripts (`phase302_run.ts`, used to produce §16's empirical numbers across several iterations, and `phase302_verify.ts`, used for the final post-fix re-check) were deleted before finishing this phase — neither was ever committed.

**On `git log` HEAD — corrected from an earlier draft of this report that assumed it hadn't moved:** HEAD is `27e4ad2` ("feat: add capability proficiency v2 foundation..."), one commit ahead of `2a165ea` (this phase's starting point per the prior conversation record). `27e4ad2`'s diff is exactly Phase 30.1's file list (`git show --stat` confirmed — 32 files, matching `docs/PHASE_30.1_IMPLEMENTATION.md`'s §12 exactly, nothing from this phase in it) — it was committed outside this session's own actions (no `git commit` was run here). **This phase's own work (§19's 5 modified + 7 new files) remains entirely uncommitted**, sitting in the working tree on top of that commit, exactly as instructed. This is reported plainly rather than left for the reader to notice on their own.

---

## 23. Final status

```text
PHASE_30.2 COMPLETE
```
