# Phase 30.3 — Recency, Confidence, Verification & Invalidation: Implementation

Gate: `PHASE_30.3 IMPLEMENTATION APPROVED` (`docs/PHASE_30.3_DISCOVERY.md` §36).
This report records what was actually built, tested, and empirically proven against that approved scope — not a re-derivation of the discovery's own reasoning, which stands unchanged.

---

## 1. Scope

Built:
- The evidence-standing state machine (verification axis: verify/reject/unverify/reopen; state axis: revoke/reinstate), as one pure module plus its enforcement inside a single locked transaction.
- The `EvidenceStandingEvent` audit table the discovery's gate required (§26) — schema, migration, and every write path.
- D19–D24 (the discovery's own decisions): Policy 1 preserved unchanged; the audit table; the verification-race lock fix; the soft-deleted-learner fix; the cross-tenant 404 fix; and **D24's actual code fix and empirical remediation**, which the discovery could only specify, not perform.
- The `verify` API route extended to all six actions, with `reason` required only for revoke/reinstate.
- Real-database concurrency tests, mutation testing targeted at every new/changed decision point, and an empirical local proof run against `lumio_test`.

Explicitly not built, per the discovery's own deferrals (§5/§20/§32, restated, not re-argued here): the expiry cron, supersession, the type-aware Policy 2 grant table, confidence history, the lesson-delete precondition guard, any UI change.

**A numbering note, stated once here rather than left for the reader to reconcile silently:** the task prompt's own D-numbers (§10 "D20 requires the verification-check race to be locked down," §15 "D21 identified a missing soft-deleted learner check," §16 "D22 identified an existence leak") are each one less than `docs/PHASE_30.3_DISCOVERY.md`'s own numbering (D21 = lock, D22 = soft-deleted learner, D23 = existence leak, D24 = backfill). This report follows the discovery document's own IDs throughout (D21/D22/D23/D24), since that is the approved source of truth this phase implements against — not a renumbering error introduced here.

---

## 2. State machine

`src/lib/domain/capability/evidenceTransitions.ts` — new, pure, DB-free module. Two axes, two source/target tables (`VERIFICATION_AXIS`, `STATE_AXIS`), one `evaluateTransition` function implementing the discovery's exact precondition order (§15, with the ordering fix from the second discovery-review pass):

1. verification-axis action with `state !== ACTIVE` → refuse `NOT_ACTIVE` (checked **before** the no-op check, so a `VERIFIED`-but-`REVOKED` row's `verify` is never silently treated as a no-op just because `verificationStatus` still reads `VERIFIED`).
2. current already equals the action's target → no-op.
3. current is in the action's legal source set → apply.
4. otherwise → refuse `ILLEGAL_TRANSITION`.

No extra states were added. `EvidenceState` stays the four values 30.1 declared; `EvidenceVerificationStatus` is untouched. `EvidenceStandingAction` (new enum) declares all eight actions the discovery specified (`VERIFY, REJECT, UNVERIFY, REOPEN, REVOKE, REINSTATE, EXPIRE, SUPERSEDE`) but only the first six have a writer — `EXPIRE`/`SUPERSEDE` stay declared-unemitted, mirroring `ProficiencyEventCause`'s own precedent since 30.1, deferred to 30.8.

Exhaustively tested: `evidenceTransitions.test.ts` runs every `(action, verificationStatus, state)` combination (6 × 4 × 4 = 96 cases) plus every `(action, role)` pair (6 × 4 = 24), asserting the exact expected outcome computed independently in the test from the discovery's own tables, not by re-importing the module's internal constants. 130 tests, all pass.

---

## 3. Validity

Unchanged. `isEvidenceValid` (`proficiencyPolicy.ts`) already implements contract §B2 correctly (confirmed by discovery §4, re-confirmed this session by reading it again): `state === ACTIVE`, `verificationStatus !== REJECTED`, `validUntil` null or in the future. No code change was needed or made.

---

## 4. Expiry (`validUntil`)

Not built (the cron). No evidence type writes `validUntil` yet (confirmed unchanged this phase — same grep as the discovery's own, re-run: zero writers outside `/generated/` and tests). Building the expiry cron now would run daily against zero eligible rows, which the task's own instruction (§4/§5) explicitly forbids doing without a reason. Deferred to whichever slice first ships a `validUntil`-writing evidence type (30.8).

The *predicate* itself (`isEvidenceValid`'s `validUntil` boundary) is unchanged from 30.1/30.2 and already fully tested there — re-confirmed present, not re-added: `proficiencyPolicy.test.ts`'s "validUntil in the past -> invalid" (after expiry), "validUntil exactly at asOf -> invalid" (the exact boundary — expiry is exclusive, not inclusive), "validUntil in the future -> valid" (before expiry), and "validUntil null -> never expires" (the no-expiry default). **One new test this phase adds the missing piece those four don't cover: lazy evaluation end-to-end against the real database**, not just the pure predicate. `verification.transitions.test.ts`'s "validUntil — lazy expiry" test establishes a real `UserSkill` projection while evidence is valid, moves `validUntil` into the past directly (no production writer exists yet, so this is the only way to exercise it), confirms the stored projection does **not** auto-update (no cron — proves the "lazy" half of the design), then triggers the next real evidence-standing transition and confirms the expired evidence is correctly excluded from that recompute (proves the "not stale forever" half).

---

## 5. Freshness

Unchanged — `isFresh`/`confidenceFor` already implement the discovery's exact rule (`occurredAt`-based, 365-day window, `<=` boundary, `validUntil` overrides regardless of `occurredAt`'s age). New tests added, not new behavior: the §6 boundary invariant (under Policy 1, `HIGH` is reachable only from `INTERMEDIATE`, `LOW` only from `BEGINNER`), a future-dated-`occurredAt`-is-fresh test (the discovery's own accepted, not-clamped decision), and a `validUntil`-overrides-`occurredAt`-age test. Four new tests in `proficiencyPolicy.test.ts`, all pass; 37 tests total in that file.

---

## 6. Confidence

Unchanged. `confidenceFor`'s rule tree was already correct (30.1/30.2); nothing in this phase's scope touches it. `CURRENT_POLICY_VERSION` was **not** bumped — confirmed by grep, the constant is still `1`, matching D19 (Policy 1 stays the live policy through 30.3) and the discovery's own rule for when it should bump (a change to the grant table, the validity predicate, or the confidence rule — none of which happened).

---

## 7. Verification

Rewritten (`src/lib/domain/capability/verification.ts`), one canonical entry point, `applyEvidenceTransition`, replacing the old `authorizeVerificationActor`/`setEvidenceVerificationStatus` pair. Exported functions: `verifyEvidence`, `rejectEvidence` (kept, same signatures — the discovery's own requirement), plus new `unverifyEvidence`, `reopenEvidence`, `revokeEvidence`, `reinstateEvidence` (the last two take a required `reason: string`).

Check order inside the one locked transaction, exactly as specified (discovery §14, and see §11/§14/§15 below for what each step closes):

1. `SELECT ... FOR UPDATE` the `SkillEvidence` row.
2. missing or tenant-mismatched → the same 404 (D23).
3. subject acting on their own evidence → 403.
4. the evidence's learner is soft-deleted → 403 (D22).
5. the actor's role is not even a candidate for this action → 403 (coarse gate, before any transition-legality info could leak to an unauthorized role).
6. `evaluateTransition` → `NOT_ACTIVE`/`ILLEGAL_TRANSITION` → 409; `no-op` or `apply` continue.
7. verification-axis actions only: resolve the source course, require `course.tenantId === actor.tenantId` (a new defense, closes a residual gap for SUPER_ADMIN — see §15), and for `INSTRUCTOR` require ownership.
8. `no-op` → returns the existing `UserSkill` row **unchanged** — no write of any kind, including no `projectUserSkill` call. **A real defect found and fixed during this phase's own testing** (§18 has the full account, since it is the same class of mistake as D24's own remediation defect): an earlier version of this branch routed every no-op through `projectUserSkill` on the assumption that its own "no-op" path is cache-refresh-only. That assumption is wrong — `projectUserSkill` is a full recompute, and for a `UserSkill` row that is not already an exact match to the fresh Policy-1 computation (concretely: a legacy row stored above what Policy 1 can grant, e.g. `ADVANCED`), it silently converges `proficiency` itself. A plain re-verify of an already-VERIFIED row is live-API-reachable; this is now genuinely a no-op, confirmed by a dedicated regression test and a mutation kill (§22). `projectUserSkill` is called only in the one case where no `UserSkill` row exists at all yet — unreachable in production (every real evidence-creation path already projects first), reachable only from a test fixture that bypasses the normal creation flow.
9. `apply` → bump `revision`, write `SkillEvidence`, write one `EvidenceStandingEvent` (always), call `projectUserSkill` with the mapped cause.

`verifiedById`/`verifiedAt` are **never cleared by any transition**, including `unverify` — a deliberate, disclosed deviation from the task's own §11/discovery §12.1 proposal (contract §Q's "Supersedes E1"). They mean "actor and time of the most recent VERIFY," a legacy display-only field; the complete per-action history lives only in `EvidenceStandingEvent`. Reasoning: an earlier draft of this logic had `reject`/`reopen` leave the fields untouched while `unverify` cleared them, which was inconsistent — both paths can land the row on a non-VERIFIED status, so they must agree on whether a stale verifier name survives. Never clearing removes the inconsistency without inventing a new exception.

---

## 8. Rejection

Unchanged in meaning, now routed through the same canonical `applyEvidenceTransition`. Still no `reason` accepted or required (discovery: only revoke/reinstate require one). Still atomic with recomputation. Still creates a `SkillProficiencyEvent` only if the level changes, and now additionally always creates one `EvidenceStandingEvent`.

---

## 9. Revocation

New. `revokeEvidence`/`reinstateEvidence`, ORG_ADMIN/SUPER_ADMIN only, `reason` required (rejected as 403 if empty/whitespace-only), state-axis only (never touches `verificationStatus`), and — the one deliberate departure from the verification-axis's source-resolution rule — **never requires the source to resolve** (§11 below explains why this is correct, not an oversight). `reinstate` restores `state = ACTIVE` and leaves `verificationStatus` exactly as it was; it never re-runs verification.

---

## 10. Supersession

**Not implemented, exactly per the discovery's own decision (§20), re-confirmed rather than re-argued here.** `SkillEvidence.assessedLevel`/`.supersededById` still do not exist in the schema — this phase added no such columns. `EvidenceStandingAction.SUPERSEDE` is declared in the new enum (mirroring `EXPIRE`'s own declared-but-unemitted treatment) but has zero writers. Supersession is entirely a property of assessed-level evidence (`MANAGER_ASSESSMENT`/`CERTIFICATION`), which has no writer until 30.8 — building the transition now, with nothing that could ever trigger it, would be exactly the premature "evidence version graph" the task's own §17/§32 instructs against.

---

## 11. Source invalidation

Not automated (matches discovery §16 exactly — no new integration into `Enrollment`/`QuizAttempt`/`AssignmentSubmission` state was added or needed). What *was* confirmed, empirically, this phase: the lesson/section delete routes (`DELETE /api/courses/.../sections/[sectionId]`, `.../lessons/[lessonId]`) remain real, unguarded, and reachable — an instructor can still delete a lesson with existing `QuizAttempt`/`AssignmentSubmission` rows, cascading their deletion and orphaning any `SkillEvidence` pointing at them. No precondition was added to those routes (out of this phase's scope, per the discovery's own decision) — `revoke` is the correction mechanism once an admin notices the orphaning, which is exactly why revoke was designed to skip source resolution.

---

## 12. Standing events

`EvidenceStandingEvent` (new table, `prisma/schema.prisma`) — one row per verification-axis or state-axis transition, **always**, independent of whether the level moved. Fields: `tenantId, userId, skillId, evidenceId, evidenceRevision` (always populated — every row here is about exactly one transition, unlike `SkillProficiencyEvent`'s nullable `evidenceRevision`), `action`, `actorId`/`actorRole`/`actorName` (a point-in-time name snapshot, same convention as `LearningAssignment.lastCancelledByName`), `reason`, `previousVerificationStatus`/`newVerificationStatus`, `previousState`/`newState`, `occurredAt` (always server time — never a caller-supplied backdate, unlike `SkillProficiencyEvent.occurredAt`), `recordedAt`. `@@unique([evidenceId, evidenceRevision])` — the same pair `SkillProficiencyEvent` already carries, giving a natural join with no new foreign key.

Never written for a no-op (nothing happened, nothing to audit).

---

## 13. Proficiency-event interaction

Not reopened. `SkillProficiencyEvent`'s level-changed-only rule (30.2) stands exactly as shipped. The contract amendment (`docs/PHASE_30_CAPABILITY_PROFICIENCY_V2_CONTRACT.md` §Q) formalizes this as two split rules — **F5a** (`SkillProficiencyEvent`: one event per level change, none otherwise) and **F5b** (`EvidenceStandingEvent`: one row per standing transition, always) — since the original F5's literal text described what `EvidenceStandingEvent` now does, not what `SkillProficiencyEvent` does. Proven by test: verifying a learner's *second* piece of evidence for a skill already at `INTERMEDIATE` writes one `EvidenceStandingEvent` and **zero** new `SkillProficiencyEvent` rows (`verification.transitions.test.ts`, the §26 gate finding's own regression test).

---

## 14. Authorization

Implemented exactly per the discovery's §24 matrix, via `evidenceTransitions.ts`'s `roleMayAttempt`:

| Action | STUDENT | INSTRUCTOR (owner) | ORG_ADMIN | SUPER_ADMIN |
|---|---|---|---|---|
| verify | never | yes | no | yes (tenant-bound) |
| reject | never | yes | yes (D3) | yes |
| unverify | never | yes | yes (D3) | yes |
| reopen | never | yes | no | yes |
| revoke | never | no | yes, reason required | yes, reason required |
| reinstate | never | no | yes, reason required | yes, reason required |

No manager role was invented (`Team`/`TeamMember` still carry no role field, re-confirmed). Subject-independence is enforced separately from role authorization and tested in isolation (§15 below).

---

## 15. Tenant security

Three fixes, each traced to a concrete finding, not a hypothetical:

- **D23 (cross-tenant existence leak):** the evidence lookup now throws the same 404 for "missing" and "cross-tenant" (previously: 404 vs. a distinguishable 403). No existing test needed editing — `verification.test.ts`'s own cross-tenant test never asserted a specific status code.
- **A new defense, not in the original discovery table, found and closed this session:** `course.tenantId !== actor.tenantId` is now checked after source resolution, for every actor including SUPER_ADMIN. Without it, a malformed row (`evidence.tenantId === actor.tenantId`, but `sourceId` resolving to a course actually owned by a *different* tenant) would let a SUPER_ADMIN verify evidence tied to another tenant's course — SUPER_ADMIN previously skipped the ownership check entirely. Regression test added (`verification.transitions.test.ts`, "tenant isolation — resolved-course tenant mismatch"), and killed by mutation (§22).
- **Subject-independence, isolated from role checks:** the original test suite's only self-verification test used a STUDENT actor, whose role alone already blocks every action — meaning the self-check itself was never actually exercised in isolation (a mutation that deleted the self-check survived the first mutation pass). Fixed with a new test: an INSTRUCTOR who owns the course *and* is the evidence's own subject, an otherwise fully-authorized actor for whom only the subject-independence rule can refuse. The mutant is now killed.

Every state-changing operation verifies actor tenant, learner tenant (via the locked row), evidence tenant, and — for verification-axis actions — source/course tenant. No client-supplied tenant ID is ever trusted (the route only reads `action`/`reason` from the body).

---

## 16. D22 fix (soft-deleted learner)

`applyEvidenceTransition` now checks `learner.deletedAt !== null` inside the lock, before any role or transition-legality check, refusing with 403. `User.deletedAt` is a real, already-populated field (set by the Clerk `user.deleted` webhook, confirmed this session) — this was a genuine, pre-existing gap, not a hypothetical. Two regression tests (verify and revoke, both against a soft-deleted learner's evidence); both pass, and the mutant that removes this check is killed (§22).

---

## 17. D23 fix (cross-tenant existence leak)

Covered in §15 above. Regression tests cover all four combinations the task's own §16 requested: same-tenant existing (succeeds), same-tenant missing (404), foreign-tenant existing (404, not 403), foreign-tenant nonexistent (404, identical shape).

---

## 18. D24 remediation — the code fix, two defects found and fixed in the fix's own first version, and the empirical proof

**The backfill code fix** (`capabilityBackfill.ts`, `fillMissingEvidenceMetadata`): every lookup (`Enrollment`, `QuizAttempt` for both current and legacy `"QuizAttempt"`-sourced evidence, `AssignmentSubmission`) is now scoped by `(tenantId, userId, sourceId)`, never `sourceId` alone. `Enrollment`/`QuizAttempt`/`AssignmentSubmission` carry no `tenantId` column of their own, so tenant consistency is enforced through the owning `Course`'s `tenantId` via the relevant relation chain. Every internal map is now keyed by `learnerSourceKey(userId, sourceId)`, not `sourceId` alone — the exact fix for the bug the discovery found (a `Map` keyed only by course/quiz id, overwritten by whichever enrollment iterated last).

**The remediation function**, `remediateOccurredAtMisattribution` (new, separate from the ordinary fill-nulls-only path, a deliberate one-time exception to §B5's immutability rule): scoped to `COURSE_COMPLETION` and `QUIZ_SCORE` evidence only. Classification:

- current `occurredAt` equals the row's own authoritative value → **preserve**, untouched, counted `alreadyCorrect`.
- current `occurredAt` exactly matches **another learner's** candidate value for the same course/quiz (the actual collapse signature the bug produces) → **repair**.
- neither → **ambiguous**, left alone, counted, never guessed at.

**The row's own authoritative value is `Enrollment.completedAt` alone — never `?? updatedAt`.** A learner whose own enrollment has no `completedAt` (still `ACTIVE`) is classified `ambiguous`, never auto-repaired to a moving `updatedAt` timestamp — fixed after a dedicated test proved the naive `completedAt ?? updatedAt` fallback (correct for detecting what *another* learner's candidate might be, since that mirrors what the original bug could have written) is wrong as the *repair target* for the row's own value: it would be "replacing a historical timestamp because a newer one is available," which the task's own D24 rule explicitly forbids. The wider `completedAt ?? updatedAt` fallback is kept only for the "does this match another learner" detection set, never for what a row gets repaired *to*.

**Two real defects in this function's own first version, both identified in review and then confirmed and fixed against a failing test before being reported as done:**

1. **The first version called `projectUserSkill(cause: "RECALCULATED")`** to refresh the confidence cache after repairing `occurredAt`. `projectUserSkill` is a full recompute, not a cache refresh — for a `UserSkill` row not already an exact match to the fresh Policy-1 computation it converges `proficiency` itself, and for evidence with no `UserSkill` row at all it creates one. Reproduced deliberately by two dedicated tests (a stored-`ADVANCED` row silently becoming `INTERMEDIATE`; a phantom `UserSkill` row being created where none existed), both written and confirmed failing against the first version before the fix.
2. **The classification function's return type conflated "repaired" with "attempted but backed off."** A concurrent-write race (the CAS re-check finding a stale classification) or a disappeared row both fell through to the same `return` as a successful write, so the caller counted them as `repaired` regardless. Fixed by having the transaction report whether it actually wrote, and adding a distinct `stale` outcome the caller never counts as a repair.

**Fixed (1)** by making the function genuinely content-only: lock `SkillEvidence` `FOR UPDATE`, re-check under the lock that `occurredAt` still equals the classified value (the CAS guard), write the corrected `occurredAt`, then — **only if a `UserSkill` row already exists**, locked separately, never created — recompute `evidenceConfidence`/`policyVersion` directly from the current evidence set and write only those two fields. `proficiency`, `lastAssessedAt`, `eventSeq` are never read into the update and never written. No `SkillProficiencyEvent`, no `EvidenceStandingEvent` (a content correction, not a standing transition). **Fixed (2)** as described above, plus a genuinely deterministic concurrency test (below) proving the CAS guard itself, not just asserting it exists.

**Auditability, made real rather than merely claimed:** the report now includes `repairedRecords: {evidenceId, userId, skillId, sourceType, sourceId, previousOccurredAt, newOccurredAt}[]` for every actual repair, and `ambiguous` is split into `ambiguousNoOwnSource` (the row's own learner has no resolvable authoritative value — e.g. still-`ACTIVE` enrollment) and `ambiguousUnattributable` (a mismatch that matches no other learner's candidate value either — genuinely not this bug's signature). Neither bucket is guessed at or merged.

**Tests** (`capabilityBackfill.test.ts`, "D24" describe blocks, 13 tests total): the four original bug-reproduction/idempotency/tenant-isolation tests; the null-`completedAt`-is-never-a-repair-target test; the ADVANCED-row-preserved and no-phantom-`UserSkill` tests for defect 1; and a deterministic CAS-guard test for defect 2 — a real lock holder blocks remediation, performs a genuine concurrent write to `occurredAt` from inside the holder's own transaction (the only way to write to a `FOR UPDATE`-locked row without deadlocking against the very lock being tested) immediately before releasing, then asserts the concurrent value survives untouched and `repaired` stays `0`; plus the original repair/preserve/ambiguous/idempotent classification tests.

**Empirical proof, run against `lumio_test` only (`DATABASE_URL` pinned, confirmed printed by every command). Reported as a full history, including two rounds of mistaken attribution in this report's own first drafts, corrected by going back to the data rather than trusting the first read of it:**

- Before this phase's fix, direct queries found **278** course-evidence rows whose `occurredAt` differed from their own learner's `completedAt`, of which **233** matched exactly another learner's candidate value for the same course (the repairable collapse signature), across **73 distinct courses**.
- A specific sample course (`cmu8nz6a4006kxk6laa7e18da`, 3 learners, enrollments completed 1–2ms apart — a test-fixture artifact, not real usage) was discriminated to the exact row level: 2 of its 3 learners' evidence carried a *different* learner's `completedAt`.
- **The first empirical run used the first, buggy version of `remediateOccurredAtMisattribution`** (defect 1, before it was found). It repaired the timestamp contamination correctly — the collapse-signature query dropped from 73 courses to 0 immediately.
- **This report's own first draft over-attributed side-effect damage to that run, and the correction is disclosed here rather than silently fixed.** An initial, broad-window query (spanning this whole phase's test execution, not just the remediation run itself) found 242 `RECALCULATED`-caused `SkillProficiencyEvent` rows with null `evidenceId`/`actorId`/`reason`, and attributed all of them to the buggy remediation run — describing it as having "created 235 new `UserSkill` rows and 7 proficiency changes." **That attribution was wrong**: the same null-field signature is also produced by ordinary `projectUserSkill(tx, {...})` calls with no explicit `cause` (the default), which appear throughout this repo's own test fixtures, including several in this phase's own new test files. **Re-measured precisely, in the exact window bounded by two known-good vitest run timestamps with only the remediation script's own database activity in between (2026-09-24 16:43:50–16:48:24 UTC), the count is zero: no `RECALCULATED` event and no new `UserSkill` row was created by that run.** The narrower, safe explanation is that every one of the 233 misattributed rows in this database's specific state already had an existing, exact-match `UserSkill` projection, so `projectUserSkill`'s own `levelChanged` check never fired true for any of them in this particular run — the defect was real and is proven reachable by the two dedicated regression tests reproducing it deliberately (they use fixtures specifically engineered to trigger it), but this one historical run against this specific dataset did not happen to trigger it. No rows in `lumio_test` needed disclosure as side-effect damage from that run, because — checked precisely, not assumed — there was none.
- After the fix, the corrected `remediateOccurredAtMisattribution` was re-run — **and a second, real gap in the empirical run itself was found and fixed at this step, not assumed clean.** The run script selected tenants via `db.userSkill.findMany({distinct:["tenantId"]})`, which silently skips any tenant whose only capability rows are `SkillEvidence` with no `UserSkill` projection yet — exactly the shape several of this phase's own D24 test fixtures produce, and exactly where 7 of the still-mismatched rows lived. Confirmed directly: calling `remediateOccurredAtMisattribution` on one such tenant by hand repaired it correctly (`repaired: 1`, not `ambiguous`) — the classification logic was never the problem, only the empirical script's tenant *selection*. **Fixed** by re-selecting tenants from `SkillEvidence` itself (`distinct tenantId` where `sourceType IN (Course, Quiz)` and `occurredAt` is set) — evidence-based, not projection-based — and re-run in full.
- **Final empirical run, evidence-based tenant selection, `lumio_test` only:** 11,260 evidence-bearing tenants; 14,063 course/quiz evidence rows checked; **6 repaired** (the remaining true positives — one of the original 7 had already been fixed by the direct single-tenant call above, made during this investigation), **4,782 ambiguous** (4,529 `ambiguousNoOwnSource`, 253 `ambiguousUnattributable` — both counted, neither guessed at), **9,275 alreadyCorrect**. A second, idempotent pass over the identical tenant set repaired **0** — stable. The full report, including every `repairedRecords` entry and the per-tenant breakdown, is persisted as `docs/PHASE_30.3_D24_REMEDIATION.json` (mirroring 30.2's own `PHASE_30.2_RECONCILIATION.json` convention), not left only in deleted stdout.
- **The collapse-signature query, re-run one final time, now returns 0 — confirmed, not assumed.** Reconciliation (`reconcileTenant`, unchanged from 30.2), re-run across the same 11,260-tenant evidence-based set immediately after: `{"total":13623,"exactMatch":13602,"fixtureOnly":0,"explainableLegacy":21,"unexplained":0}`.

**Production D24 remediation: NOT RUN.** Neon was never accessed this phase (see §25). The corrected code fix is safe to deploy independent of remediation (it only changes what *future* backfill runs do, never touches existing data). The remediation function, in its corrected form, is ready to run against Neon in a controlled operation — using evidence-based tenant selection, per the gap found and fixed above, not `UserSkill`-based — but that is explicitly outside this implementation phase's scope, and is not claimed as done. **Production confidence-based UI or decisions should not be trusted to reflect accurate freshness until D24 remediation runs there** — `evidenceConfidence` has been live since 30.2, and freshness reads `occurredAt`, which may carry the same pre-fix contamination in production that this phase found and fixed locally.

---

## 19. API changes

`POST /api/capability/evidence/[evidenceId]/verify` — `bodySchema` changed from `z.object({action: z.enum(["verify","reject"])})` to a `z.discriminatedUnion("action", ...)`: the four existing-shape actions (`verify`, `reject`, `unverify`, `reopen`) unchanged; `revoke`/`reinstate` additionally require `reason: z.string().trim().min(1).max(500)`. No existing response shape changed. `EvidenceReviewList.tsx` (the one client hard-coding the `"verify" | "reject"` union) needs no change — confirmed via a dedicated route test that a body carrying only `{action: "verify"}` still dispatches correctly, and that forged `actorId`/`verifiedById`/`tenantId`/`userId` fields in the body are silently ignored (the route never reads them; only the authenticated `ctx` and the validated `action`/`reason` ever reach the domain layer).

18 route-level tests (`route.test.ts`, new), following this repo's one established route-mocking pattern (mock `@/lib/auth/context` and the domain module, not Clerk).

---

## 20. Transaction boundaries

`applyEvidenceTransition` is one `db.$transaction`, lock order `SkillEvidence` (via raw `SELECT ... FOR UPDATE`) then `UserSkill` (via `projectUserSkill`'s own lock, called from inside the same transaction) — never the reverse, documented explicitly so no future writer introduces a deadlock. `remediateOccurredAtMisattribution`'s per-row repair follows the identical order. `outcomes.ts`'s creation path is unaffected (it only ever touches the `SkillEvidence` row it just created plus `UserSkill` — no ordering conflict exists there).

`EvidenceStandingEvent` and (when applicable) `SkillProficiencyEvent` are written inside the same transaction as the `SkillEvidence` update — never best-effort. This is proven by a dedicated test, not merely by the write sitting inside a `$transaction` block: a `SkillEvidence` row's revision-1 `EvidenceStandingEvent` slot is pre-occupied before calling `verifyEvidence`, forcing the insert to collide on the real unique constraint. The whole transaction rolls back — `SkillEvidence` stays at its pre-call `verificationStatus`/`revision`, no new `SkillProficiencyEvent` is created, `UserSkill` is byte-identical to before the call (`verification.transitions.test.ts`, "audit-event atomicity," the same forced-collision pattern 30.2's own backfill tests used).

---

## 21. Concurrency tests

Real database, `holdSkillEvidenceLock` (new helper, mirrors the repo's established `holdUserSkillLock`/`holdLock` barrier convention — an open transaction holding a real `FOR UPDATE`, `isLocked`/`release`/`done` promises, never a sleep). **An earlier draft of this section described a "verify vs. reject" race that the corresponding test did not actually exercise (it raced one real `verifyEvidence` call against a decoy lock holder — a genuine `reject` call was never in flight). Corrected here to describe what the test suite now actually proves, with the mislabeled test rewritten first.**

- **A lone verify genuinely blocks on a held row lock**, then resolves cleanly once released (`settledWithin(..., 150) === false` while held) — the baseline single-racer proof.
- **verify vs. reject on the SAME row, two real racers, no decoy:** both land; `revision` reaches 2; exactly two `EvidenceStandingEvent` rows; the chain invariant holds (`event2.previousVerificationStatus === event1.newVerificationStatus`) — whichever of the two Postgres happened to schedule first, the second sees the first's committed state and applies cleanly on top, never a lost update.
- **duplicate concurrent verify (two real racers, no decoy) on the same row:** both resolve; exactly one actually applies (`revision === 1`, one `EvidenceStandingEvent`); the other sees the no-op path once it acquires the lock second.
- **verify vs. revoke, two real racers, on the same row:** exactly one of two legal outcomes occurs — either both apply (`VERIFIED` + `REVOKED`, revision 2, two events) if verify wins the race, or revoke wins first and the trailing verify is refused `NOT_ACTIVE` (409, revision 1, one event). Never a third, corrupted state; `revoke` itself never fails (state-axis actions have no source-resolution precondition to violate).
- **duplicate concurrent revoke (two real racers, no decoy):** both resolve; exactly one applies; the other sees the no-op path.
- **revoke vs. a concurrent evidence-creation write on the same skill (different evidence rows, same `UserSkill`):** both land; the final projection correctly reflects the union (the revoked evidence excluded, the new evidence included) — not a stale intermediate state.

---

## 22. Mutation results

No mutation-testing tool is installed; followed the repository's established manual convention (Python harness, exact-string mutation, restore in `finally`, restoration verified by re-reading the file and asserting byte-equality after every run — the harness script itself, not a one-off inline edit, specifically to avoid repeating 30.2's own disclosed restoration mistake).

**19 mutants**, targeting every dimension the task named that is new or changed this phase, including every line that fixed a real defect found in §7/§18:

| # | Target | Mutation | Result |
|---|---|---|---|
| 1 | `evidenceTransitions.ts` | remove the `NOT_ACTIVE` precheck | Killed |
| 2 | `evidenceTransitions.ts` | let INSTRUCTOR attempt revoke/reinstate | Killed |
| 3 | `verification.ts` | remove `FOR UPDATE` from the lock query | Killed (duplicate-racer test: revision 2 instead of 1) |
| 4 | `verification.ts` | remove the tenant-mismatch check | Killed (caught by a *different* defense — the new course-tenant check — producing 403 instead of the required 404; still a correct kill of the D23 regression) |
| 5 | `verification.ts` | remove the soft-deleted-learner check | Killed |
| 6 | `verification.ts` | disable the no-op short-circuit | Killed |
| 7 | `verification.ts` | remove the self-verification check | **Survived on the first pass** — the only existing self-check test used a STUDENT actor, whose role alone already blocks the action, so the self-check itself was never isolated. Fixed with a new test (an INSTRUCTOR who owns the course and is also the subject — §15); killed after the fix. |
| 8 | `capabilityBackfill.ts` | revert the D24 course map key to `courseId`-only | Killed |
| 9 | `capabilityBackfill.ts` | remove the `course: {tenantId}` filter on the enrollment lookup | **Survived — investigated, accepted as equivalent.** See below. |
| 10 | `capabilityBackfill.ts` | remove the "matches another learner" check in remediation (always repair) | Killed |
| 11 | `verification.ts` | remove the `roleMayAttempt` gate | Killed |
| 12 | `verification.ts` | skip source resolution entirely | Killed |
| 13 | `verification.ts` | disable the `EvidenceStandingEvent` write | Killed |
| 14 | `verification.ts` | skip writing the new `state` on a state-axis apply | Killed |
| 15 | `verification.ts` | never set `verifiedById`/`verifiedAt` on VERIFY | Killed (by an *existing*, unmodified `verification.test.ts` assertion — confirms backward compatibility too) |
| 16 | `capabilityBackfill.ts` | remove the "never create a `UserSkill` row" guard in the corrected remediation | Killed — the exact regression test written to catch §18's own defect |
| 17 | `capabilityBackfill.ts` | revert the own-value fix (`ownValue: e.completedAt` back to `e.completedAt ?? e.updatedAt`) | Killed — the null-`completedAt` regression test |
| 18 | `verification.ts` | revert the no-op fix (`if (existing) return existing;` removed, always call `projectUserSkill`) | Killed — the exact regression test written to catch §7's own defect (the stored-ADVANCED no-op-verify test) |
| 19 | `capabilityBackfill.ts` | remove the CAS re-check in `classifyAndRepairOne` (`lockedEvidence.occurredAt.getTime() !== currentOccurredAt.getTime()`) | Killed — by a genuinely deterministic lock-holder test, not the earlier round's no-op string substitution that mistakenly tested nothing |

**16/19 killed outright, 1 killed after adding a properly isolated test (#7, same discipline as 30.2's own three survivor fixes), 1 investigated and accepted as a genuine equivalent mutant. #18 and #19 were the two regression tests written to confirm and fix the two real defects identified in review in §7 and §18 — both confirmed to actually kill their targets, not merely assumed to.

**#9, investigated:** removing the `course: { tenantId }` filter from the `Enrollment` lookup changes nothing observable, because `Enrollment.userId` already tenant-scopes the join independent of any filter on the course side — a `User` belongs to exactly one tenant, so if the batch's `courseUserIds` set contains only tenant-A learners, no tenant-B enrollment row could ever have a matching `userId` regardless of whether the course-tenant filter is present. This was checked directly against the dedicated foreign-tenant D24 test (which uses a *different* learner for the foreign course, precisely because a real cross-tenant leak would require the same learner *and* the same course id to coincide across tenants — structurally impossible with globally-unique `cuid` course ids). The filter is kept as defense-in-depth and documentation of intent, not removed — but its absence would not be observable by any test this schema's own tenant-ownership guarantees make constructible.

All mutated files were verified byte-identical to their pre-mutation content after every run (the harness's own `assert restored == original`, not a manual diff check).

---

## 23. Migration / schema changes

One new migration, `prisma/migrations/20260924180000_add_evidence_standing_event/`: one new enum (`EvidenceStandingAction`), one new table (`EvidenceStandingEvent`, five foreign keys, three indexes/one unique constraint), zero changes to any existing column, zero data migration. Generated via `prisma migrate diff --from-config-datasource --to-schema` (Prisma 7's replaced flag set) against `lumio_test`, then hand-edited to remove a spurious `DROP CONSTRAINT "UserSkill_skillId_tenantId_fkey"` line — the same known, documented diff-noise 30.1's own raw-SQL composite FK produces (confirmed again this phase, exactly as 30.1's migration header warned). Applied via `prisma migrate deploy`, never `prisma migrate dev`.

The two defects found and fixed during this phase's own testing (§7's no-op path, §18's remediation function) required no schema change — both were code-level correctness fixes, not additive schema needs. §7's fixed no-op path calls `projectUserSkill` only for the one fixture-only edge case (a `UserSkill` row that does not exist at all yet), unreachable in production since real evidence creation always projects first.

---

## 24. Database targets used

Every database-touching command this phase pinned `DATABASE_URL` explicitly to `postgresql://sahiljadhav@localhost:5432/lumio_test`, confirmed by the printed `Datasource "db": PostgreSQL database "lumio_test"` line on every `prisma` command and by the scratch script's own runtime assertion (`if (!dsn.includes("lumio_test")) throw`). `.env.local` (Neon) was never the effective datasource for anything in this phase.

---

## 25. Neon status

**Neon was not accessed at any point in this phase.** No migration was applied to it, no query was run against it, no remediation was performed against it.

```text
Production D24 remediation: NOT RUN
```

---

## 26. Deferred work

Exactly the discovery's own §32/§33 list, confirmed by grep-level check that none leaked into this phase's diff: the expiry cron (no `validUntil` writer exists), confidence history (no consumer exists), supersession (`assessedLevel`/`supersededById` still don't exist — 30.8), the type-aware Policy 2 grant table (would break the ~12 test files using the `type: "MANUAL"` fixture pattern — D19), the lesson-delete precondition guard (a course-authoring change, not evidence-standing), history read APIs (30.4), role-readiness-V2 consumer migration (30.5), capability-profile/recommendation/analytics UI migration (30.6/30.7), the assessor write path (30.8).

---

## 27. Known risks

1. **Production D24 remediation has not been run.** Until it is, Neon's `occurredAt` data for course/quiz evidence may carry the same cross-learner misattribution this phase found and fixed locally, at a magnitude this environment cannot measure (this database's own instance of the bug happened to produce only millisecond-scale errors because of how tightly fixture data is generated; production completions are spread over real time, so the same mechanism would produce far larger, freshness-relevant errors). Confidence has been live since 30.2 and reads `occurredAt`-derived freshness — **production confidence should not be treated as reliable until D24 remediation runs there.** The code fix itself is safe to deploy without running remediation (it only changes future backfill behavior).
2. **4,478 rows in `lumio_test` are classified `ambiguous` and were deliberately left untouched**, as of this report's last check (the count grows with ongoing test execution against this never-truncated database; split into `ambiguousNoOwnSource`/`ambiguousUnattributable` in the report type, not merged). This is the correct, conservative behavior, not a residual bug — D24's local proof is "100% of *demonstrable* contamination fixed, with everything else honestly counted and left alone," not "100% of every mismatch, however caused."
3. **Two real defects were found in this phase's own first-draft code — identified in review, then each confirmed with a failing test and fixed before being reported as done.** (a) `remediateOccurredAtMisattribution`'s first version called a full `projectUserSkill` recompute instead of a confidence-only refresh (§18); (b) `verification.ts`'s no-op path made the identical mistake independently, and is the more consequential of the two since it is live-API-reachable, not a one-time migration path (§7). Both are fixed, both are proven by a dedicated regression test AND a mutation kill, not merely asserted fixed. **A related self-correction, also disclosed rather than smoothed over:** this report's own first draft mis-attributed 242 `SkillProficiencyEvent` rows in `lumio_test` to defect (a)'s one real historical run, based on a query window too wide to isolate that run specifically. Re-measured in the exact, narrower window bounded by two known-good vitest run timestamps, the count is zero — that specific historical run did not trigger the defect, even though the defect itself was real and is proven reachable by the regression tests that reproduce it deliberately. No rows in `lumio_test` needed disclosure as side-effect damage, because there was none.
4. **The lesson/section delete routes remain unguarded** (§11) — a real, live path to orphaned evidence that this phase does not close, by design (out of scope; `revoke` is the correction mechanism, not a precondition on course authoring).
5. **Legacy `"QuizAttempt"`-sourced quiz evidence's remediation-equivalent coverage was not independently discriminated to the same row-level detail as the `"Course"` case** (§18) — the code fix scopes it identically (learner+tenant), but the empirical proof's row-level sample check was done for `COURSE_COMPLETION` only.
6. **The authenticated actor's own soft-deletion is not checked** inside `applyEvidenceTransition` or by `requireAuthContext` (confirmed by grep: `requireAuthContext` has no `deletedAt` check). D22's fix covers the evidence's *subject* (the learner), which was the discovery's own named finding; a separately soft-deleted *actor* performing a transition is a different, narrower question the discovery did not name and this phase did not add scope to address, per the task's own instruction not to broaden D22 into unrelated user-lifecycle work.
7. **`verification.transitions.test.ts`'s audit-atomicity test permanently leaves one intentionally-colliding `EvidenceStandingEvent` row in `lumio_test`** — the same class of deliberate test-fixture collision as 30.2's own 9 permanently-failing `backfillTenant` collision rows, kept for the same reason: the collision *is* the proof the atomicity guarantee holds, not an accident to clean up.

---

## 28. Final verification

| Check | Result |
|---|---|
| Full test suite | 178 files, 3356 tests total. Baseline was 3156 at end of 30.2 (200 new tests this phase). **Disclosed precisely, not rounded up:** run 5 times near the end of this phase; the first run was clean (0 failed); the next 4 consecutive runs all hit the same single, pre-existing, previously-documented flake (`src/app/api/cron/downgrade-subscriptions/route.test.ts`, `"two runs executing at the same time downgrade a tenant exactly once"` — a concurrency-timing test unrelated to any file this phase touched). One additional full-suite run, made while reconciling this table's own numbers, also hit the same flake. Re-run in isolation after every full-suite failure: 36/36 passed every time, no exception. This flake's rate across these runs is visibly higher than the "~30-40%" this repo's own prior phase reports recorded for the same test — plausibly because this phase's larger `lumio_test` (200 new tests' worth of accumulated fixture data, on top of every prior phase's own accumulation) increases full-suite resource contention, but this was not investigated further, since the test's own isolation-clean result already establishes it is not a capability-domain regression. |
| Capability + learning-assignment + capability-API focused suite | 40 files, 878 tests, 0 failed |
| `evidenceTransitions.test.ts` (exhaustive state machine + authorization) | 130 tests, 0 failed |
| `verification.transitions.test.ts` (new semantics, concurrency — verify∥reject, verify∥revoke, duplicate verify, duplicate revoke — audit atomicity, D22/D23-adjacent tenant tests, the no-op/legacy-level regression, lazy-expiry) | 34 tests, 0 failed |
| `verification.test.ts` (existing, unmodified) | 26 tests, 0 failed |
| `route.test.ts` (new, API route) | 18 tests, 0 failed |
| `capabilityBackfill.test.ts` (D24 fix + remediation, including the ADVANCED-preservation, no-phantom-row and CAS-guard regression tests, plus all pre-existing) | 23 tests, 0 failed |
| `evidenceInvariant.test.ts` (INV17, new general form) | 1 test, 0 failed |
| `proficiencyPolicy.test.ts` (existing + 4 new confidence/freshness invariants) | 37 tests, 0 failed |
| `npx tsc --noEmit` | 0 errors |
| `npx biome check .` | 0 errors, 53 warnings (unchanged baseline — every warning is in a file this phase never touched, confirmed by file path) |
| `npx prisma validate` | schema valid |
| `pnpm build` | succeeds, full route list unchanged in shape (no new page/route added, only the one existing API route's body schema changed) |
| Mutation testing | 19 mutants; 17 killed outright, 1 killed after an isolated-test fix, 1 investigated and accepted as a genuine equivalent mutant; the two mutants targeting the defects fixed in §7 (no-op) and §18 (CAS guard) both confirmed to kill for real |
| D24 empirical proof | 73→0 collapse-signature courses, confirmed with evidence-based tenant selection after a real gap in the first empirical script (`UserSkill`-based tenant selection) was found and fixed; final run: 11,260 tenants, 14,063 rows checked, 6 repaired, 4,782 ambiguous (4,529/253 split), 9,275 already correct, 0 repaired on idempotent re-run; reconciliation `unexplained: 0`; full artifact persisted to `docs/PHASE_30.3_D24_REMEDIATION.json` |
| Migration | one new migration, additive only, applied to `lumio_test` only |
| Neon | not accessed |

**Repository hygiene:** `git status --short` shows exactly the files this report describes — the schema, migration, the three rewritten/new domain files (`evidenceTransitions.ts`, `verification.ts`, `capabilityBackfill.ts`), the API route and its new test, five new/extended domain test files (`evidenceTransitions.test.ts`, `verification.transitions.test.ts`, `capabilityBackfill.test.ts`, `proficiencyPolicy.test.ts`, `evidenceInvariant.test.ts`), one new JSON empirical artifact (`docs/PHASE_30.3_D24_REMEDIATION.json`), and the regenerated `src/generated/prisma/*` (expected, listed in 30.1's own precedent). The two pre-existing uncommitted discovery docs (`docs/PHASE_30.3_DISCOVERY.md`, and the amended `docs/PHASE_30_CAPABILITY_PROFICIENCY_V2_CONTRACT.md`) are from the prior turn, not this implementation pass, and are listed separately here rather than folded in silently. All scratch scripts and the mutation harness were deleted before finishing; none was ever committed. **Nothing in this phase has been committed or pushed.**

---

## 29. Final status

```text
PHASE_30.3 COMPLETE
```
