# Phase 30.1 — Capability & Proficiency V2 Foundation: Implementation

Gate: `PHASE_30.1 APPROVED` (`docs/PHASE_30_CAPABILITY_PROFICIENCY_V2_PREFLIGHT.md`, §"Final approval gate").
This report records what was actually built against that gate's six conditions, and nothing beyond the foundation slice.

---

## 1. Scope implemented

- Additive schema foundation: `SkillEvidence`/`UserSkill` new columns, the new `SkillProficiencyEvent` table, three new enums, one composite tenant FK.
- A pure, deterministic capability policy module (`proficiencyPolicy.ts`): `ceilingFor`, `isEvidenceValid`, `doesEvidenceContribute`, `confidenceFor`, plus `projectProficiency` and the `isAssessable`/`MAX_GRANTABLE_LEVEL` primitive.
- A pure readiness evaluator foundation (`readiness.ts`): `evaluateRequirement`, returning MET/BELOW/MISSING/NOT_ASSESSABLE — established, not yet wired into the four existing consumers.
- The standalone early G1 guard (contract D7), approved by the pre-flight audit as separable: unassessable gaps are excluded from `getRecommendedLearning` and from `createCapabilityGapAssignment`.

Nothing else. No backfill, no recomputation, no event writes, no assessor path, no semantic cutover.

---

## 2. Schema changes

**`SkillEvidence`** — `occurredAt DateTime?`, `validUntil DateTime?`, `state EvidenceState @default(ACTIVE)`, `revision Int @default(0)`, `scorePercent Float?`. All pre-existing columns kept, including the ones V2 deprecates (`proficiency`, `metadata`, `userSkillId`).

**`UserSkill`** — `evidenceConfidence EvidenceConfidence?`, `eventSeq Int @default(0)`, `policyVersion Int?`. Pre-existing `confidence`/`targetProficiency`/`status` kept.

**`SkillProficiencyEvent`** (new table) — every field the contract's §F6/history questions need: `tenantId`/`userId`/`skillId`, `seq`, `cause`, `evidenceId`/`evidenceRevision`, `actorId`/`actorRole`, `reason`, `previousProficiency`/`newProficiency`, `previousConfidence`/`newConfidence`, `policyVersion`, `contributing` (Json), `occurredAt`/`recordedAt`. Constraints: `@@unique([userId, skillId, seq])`, `@@unique([evidenceId, evidenceRevision])`, three query indexes. Empty in every environment this touched — no runtime path writes to it.

**Enums** — `EvidenceState` (ACTIVE/SUPERSEDED/EXPIRED/REVOKED), `EvidenceConfidence` (LOW/MEDIUM/HIGH), `ProficiencyEventCause` (the eleven values from contract §F7).

**Not added** — assessor fields (`assessedLevel`, `supersededById`) on `SkillEvidence`. The task explicitly permitted waiting on these ("prefer waiting" if they can wait until 30.8 without blocking the foundation), and nothing in 30.1 needs them: the policy module's Policy 1 never reads them, and adding an unused nullable column now would be schema surface with no caller. Deferred to 30.8 as scoped.

**Deviation from the discovery, made explicit per the task's instruction to report contradictions rather than silently change semantics:** the composite tenant FK is **not** modeled as a Prisma `@relation`. Prisma's relation DSL has no clean way to declare a second, defense-in-depth foreign key across a column (`skillId`) already used by an existing single-column relation without either a naming collision or an awkward redundant back-array. The constraint is instead added as raw SQL in the migration file (`ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY (skillId, tenantId) REFERENCES Skill(id, tenantId)`), with a supporting `@@unique([id, tenantId])` on `Skill` that *is* declared in `schema.prisma` (needed as the FK's target). This is not a change to the approved architecture — the FK exists, enforces exactly what the audit specified, and was proven against the local test database (§4/§9) — only to *how* it is expressed. **Known risk:** `prisma migrate diff` does not know about this raw-SQL constraint and will report it as "should be removed" if the current DB state is diffed against `schema.prisma` (confirmed, §9). A future schema change must not let an auto-generated migration silently drop it; whoever runs `migrate dev` next should be aware of this one raw addition. Documented here and in the migration file's own comment.

---

## 3. Migration safety

Applied for real against the local test database (`lumio_test`, 535K users / 19,373 `SkillEvidence` rows / 16,206 `UserSkill` rows accumulated from the project's test history) via `prisma migrate diff --script` (read-only diff) followed by `prisma migrate deploy` (non-interactive apply) — never through `prisma migrate dev`, which requires a TTY. `DATABASE_URL` was pinned explicitly to `lumio_test` for every command that touches a database; `.env.local` (Neon) was never the effective datasource, confirmed by the printed `Datasource "db": PostgreSQL database "lumio_test"` line in every command's output.

Per pre-flight condition 2: the composite FK is `ADD CONSTRAINT ... NOT VALID` (fast, no table scan) followed by a separate `VALIDATE CONSTRAINT` statement (full scan, but under `SHARE UPDATE EXCLUSIVE`, which does not block concurrent reads or writes) — the two-step technique the audit named as missing from the original zero-downtime claim.

Per pre-flight condition 3: the one index built directly on an existing table (`Skill(id, tenantId)`) uses a plain, non-`CONCURRENTLY` `CREATE UNIQUE INDEX`, with the reasoning documented inline in the migration file: `Skill` is a small, tenant-scoped catalog table (bounded by how many skills a tenant defines), not a high-volume table like `SkillEvidence`/`UserSkill`, so a brief lock during index build is low risk. This is the audit's own explicitly-allowed alternative to `CONCURRENTLY` ("or document why a particular index does not need concurrent creation").

Per pre-flight condition 1/the gate's split of D8: only the one relationship the audit found clean (`UserSkill` vs `Skill`) got a constraint. The other three (`SkillEvidence` vs `User`, `SkillEvidence` vs `Skill`, `UserSkill` vs `User`) were **not** added — no schema change proposes them, matching the gate's condition exactly.

**Empirical result, not just a plan:** the migration ran cleanly against the accumulated test data, including the `VALIDATE CONSTRAINT` step, which requires zero pre-existing violations — and found none (matching the pre-flight audit's own finding of 0 `UserSkill.tenantId` vs `Skill.tenantId` violations, §5 of the preflight). Post-migration counts confirmed unchanged: 19,373 `SkillEvidence` rows, 16,206 `UserSkill` rows, all new columns at their default (`state='ACTIVE'`, `revision=0`, `eventSeq=0` for every row), `SkillProficiencyEvent` at 0 rows.

**Caveat inherited from the pre-flight audit and restated, not resolved:** this is the local test database, not production. It is a stronger proof than a plan alone (it is a real Postgres 17 instance with real accumulated data, not a toy fixture), but it is not a substitute for running the same validation against Neon before this migration is applied there.

---

## 4. Policy implementation (`src/lib/domain/capability/proficiencyPolicy.ts`)

Pure, side-effect free: no Prisma import, no `db` read, no AI call, no auth/request context — confirmed by the file having zero imports beyond `@/generated/prisma/client` (types only) and `proficiencyOrder.ts` (also pure).

- **`ceilingFor`** — Policy 1, reproducing V1's `proficiency.ts:ceilingFor` exactly: type-agnostic, VERIFIED→INTERMEDIATE, else non-rejected→BEGINNER, REJECTED→NONE.
- **`isEvidenceValid`** — contract §B2: ACTIVE, not REJECTED, `validUntil` null or strictly in the future. Deliberately does not check tenant consistency (no tenant fields on the pure `EvidenceStanding` type); that remains the caller's query-scope responsibility, exactly V1's own posture.
- **`doesEvidenceContribute`** — contract §B3. Documented and tested as provably equal to `isEvidenceValid` under Policy 1 (the only NONE grant, REJECTED, is already excluded by validity) — and documented as the seam where Policy 2 (30.3) will make them diverge (reserved types grant NONE while still being valid).
- **`projectProficiency`** — the pure core of what `proficiency.ts`'s DB-bound recompute does; order-independent by construction. Not called by any runtime path.
- **`confidenceFor`** — contract §D1/§D2 exactly: HIGH (fresh VERIFIED), MEDIUM (stale VERIFIED, or ≥2 distinct unverified types), LOW (otherwise), null for NONE or no supporting evidence. Freshness window is the code constant `CONFIDENCE_FRESHNESS_WINDOW_DAYS = 365`.
- **`MAX_GRANTABLE_LEVEL`** — derived by actually evaluating `ceilingFor` over the known verification statuses (`maxProficiency(["UNVERIFIED","VERIFIED"].map(...))`), never a literal `"INTERMEDIATE"` string in the assessability logic itself (only in one clearly-labelled regression assertion in the test file, anchoring today's known value).
- **`isAssessable`** — `compareProficiency(required, MAX_GRANTABLE_LEVEL) <= 0`. No `=== "ADVANCED"` or `< "ADVANCED"` anywhere in the implementation.
- **`CURRENT_POLICY_VERSION = 1`** exported for 30.2 to use; not written anywhere yet.

**Policy 2 was not built.** Only Policy 1 exists. The module's header comment states this explicitly and names Phase 30.3/30.8 as where the type-aware grant table and assessed-level evidence are added.

---

## 5. Assessability implementation

`isAssessable`/`MAX_GRANTABLE_LEVEL` live in `proficiencyPolicy.ts` (see §4) rather than `proficiencyOrder.ts`, which the pre-flight audit's §8/§24 suggested. Reasoned deviation, documented in both files: `proficiencyOrder.ts` has zero imports and would need to import `proficiencyPolicy.ts` to get `isAssessable`, but `proficiencyPolicy.ts` already imports `proficiencyOrder.ts` for `compareProficiency`/`maxProficiency` — putting the primitive in `proficiencyOrder.ts` would create an import cycle. Keeping it in the policy module (which is where "what can the policy grant" conceptually belongs) avoids the cycle without giving the comparison-primitives file a policy dependency it doesn't otherwise need. This is a placement refinement, not an architecture change — the primitive's behavior and derivation method are exactly what the audit specified.

Verified never to hard-code a level name: the primary test (`proficiencyPolicy.test.ts`, "matches the policy's ceiling for every proficiency level, without the test (or the implementation) naming a level") iterates `PROFICIENCY_ORDER` and computes the expected boolean from `MAX_GRANTABLE_LEVEL`'s ordinal position, never writing `"ADVANCED"`/`"EXPERT"` as an expected-value literal.

---

## 6. Readiness evaluator

`src/lib/domain/capability/readiness.ts` — new file, not `proficiencyOrder.ts` as the pre-flight suggested. Same reasoning as §5: the evaluator needs `isAssessable` (from the policy module) and `isAtLeast`/`PROFICIENCY_ORDER` (from the order module); putting it in either of those two would create the same cycle risk once policy imports order. A third, dedicated file avoids it. Documented in the file's own header comment as an explicit, reasoned deviation from the audit's specific file suggestion (not from its underlying architecture).

`evaluateRequirement(required, current)` returns `{ requiredProficiency, currentProficiency, status, levelsShort }` with `status ∈ MET | BELOW | MISSING | NOT_ASSESSABLE`. MET is checked first and unconditionally (a learner who already meets a requirement is MET regardless of general assessability); NOT_ASSESSABLE is derived from `isAssessable`, never a hard-coded level.

**Not done, as scoped:** no role-level `{ready, met, total}` aggregate (contract §G4, explicitly deferred past 30.1). No migration of the four existing readiness call sites (`gaps.ts:167`, `organizationReport.ts:247`, `instructorReport.ts:262,366`) — all four are byte-for-byte unchanged; the evaluator exists standalone, proven equivalent by its own test suite, not yet consumed by production code. This was a deliberate choice, not an oversight: migrating four production read paths for no behavior change is exactly what the phase brief's "unless necessary to prevent duplicated semantics" guards against forcing prematurely.

---

## 7. G1 guard status

**Implemented**, as the task's explicit standalone option (contract D7, pre-flight-recommended for early approval given 459 live-shaped rows already existed in test data targeting unreachable requirements).

- `recommendations.ts`: `unmetGaps = gaps.filter((g) => !g.met && isAssessable(g.requiredProficiency))` — one line changed, one import added.
- `assignments.ts` (`createCapabilityGapAssignment`): one new early-return, `if (!isAssessable(gap.requiredProficiency)) return { skip: "GAP_NOT_ASSESSABLE" }`, placed immediately after the existing `GAP_ALREADY_MET` check.
- `types.ts`: `AssignmentSkipReason` gained the `"GAP_NOT_ASSESSABLE"` literal.
- `learning-assignment-api.ts`: one new map entry, `GAP_NOT_ASSESSABLE: { status: 400, message: GENERIC_INVALID }` — required by the existing `satisfies Record<AssignmentSkipReason, ...>` type check, and grouped with the sibling `GAP_NOT_FOUND`/`GAP_ALREADY_MET` entries with the same note ("the remaining reasons belong to the mandatory and capability-gap sources, which these routes never create").

**What changed:** an unmet gap whose required level is above `MAX_GRANTABLE_LEVEL` is never recommended and never produces a new `CAPABILITY_GAP` assignment.
**What did not change:** `computeCapabilityGap`, `gap.met`, every ordinary (assessable) gap's recommendation and assignment behavior, and every other skip reason. No existing `LearningAssignment` row was touched or cancelled. No historical data was rewritten.
**Correctness note surfaced during implementation:** `createCapabilityGapAssignment` has no live API route calling it anywhere in the repository today (confirmed by an explicit grep) — the function is exported and exercised only by its own test suite (`assignments.provenance.test.ts`, `learnerAssignments.test.ts`). The 459 rows the pre-flight audit found in the test database were produced by that test suite's own repeated runs, not by live user traffic. This does not change the guard's correctness or value (the function is real production code, and the guard is correct wherever/whenever it is eventually routed), but the phrasing "459 live assignments" in the pre-flight audit should be read as "459 rows produced by this domain function, including via its own tests" — clarified here rather than left ambiguous.

**Regression tests added for the exact G1 case** (per the task's explicit requirement):
- `recommendations.test.ts`: an EXPERT-required gap with a mapped, published course is never recommended, even as the only gap; a second test proves the guard narrows rather than silences everything (an assessable gap alongside an unassessable one still gets recommended).
- `assignments.provenance.test.ts`: an ADVANCED-required gap returns `{ ok: false, reason: "GAP_NOT_ASSESSABLE" }` and creates no `LearningAssignment` and no `Enrollment`.

---

## 8. Existing behavior preservation

**Untouched code paths:** `proficiency.ts` (`projectUserSkill`, `ceilingFor`), `outcomes.ts` (all three evidence writers), `verification.ts`, `reconciliation.ts`, `gaps.ts` (`computeCapabilityGap`), `organizationReport.ts`, `instructorReport.ts`, `courseSkillManagement.ts`, `roleManagement.ts`, `copilotContext.ts` and its instructor/org siblings, every capability/role/skill API route. Confirmed by `git status` and `git diff` showing no modification to any of these files.

**Three existing tests had to be edited, not left broken — and this is reported explicitly rather than silently done, per the task's own distinction between "unintentional regression" (fix the code) and an approved, intentional behavior change (fix the test):**

| File | What broke | Why | Fix |
|---|---|---|---|
| `assignments.provenance.test.ts` | "keeps two skill gaps closed by the same course as two separate assignments" used an ADVANCED-required second skill | The G1 guard (§7), which this same task authorizes, now skips ADVANCED-required gap-assignment creation | Changed the second skill's required level to BEGINNER — the test's actual subject (two skills → two rows) is independent of which reachable level is used |
| `assignments.provenance.test.ts` | "ignores client-supplied provenance and proficiency claims" used `required: "ADVANCED"` as the *true* value the forged client input should be overridden by | Same guard | Changed to `required: "INTERMEDIATE"`; the anti-forgery assertion is unchanged in kind, just at a reachable level |
| `learnerAssignments.test.ts` | "keeps two skill-gap assignments for one course as two rows" used an ADVANCED second skill | Same guard | Changed to BEGINNER, same reasoning as row 1 |
| `recommendations.test.ts` (4 tests) | Severity-ranking and top-5-cap tests used EXPERT/ADVANCED-required gaps to manufacture high severity or extra candidates | Same guard — these levels are now excluded from recommendations entirely | Redesigned each to use only the two severities reachable under Policy 1 (1: `NONE→BEGINNER`/`BEGINNER→INTERMEDIATE`, 2: `NONE→INTERMEDIATE`) while preserving each test's original assertion (ordering, tie-breaks, cap-then-drop shape) |

Every one of these edits changes only the *proficiency level chosen for the test fixture*, never the assertion being made or the number of rows/candidates the test's logic depends on being present. None was weakened; each still proves exactly what it proved before, using a level the current policy can grant.

**Read-only confirmation of the read/display side:** `adminAssignments.test.ts`'s fixture that directly `db.learningAssignment.create`s an ADVANCED-reason row (to test `listOrgAssignments`' display formatting) was left untouched and still passes — proving old ADVANCED/EXPERT assignment rows remain fully readable and displayable, exactly as required ("historical data" is not rewritten by this guard).

**No other test file** referencing ADVANCED/EXPERT was affected — verified by checking every one of the 17 test files matching those strings in the repo and confirming the rest either never call the two guarded functions, or (the org/instructor capability reports and copilot contexts) use a completely separate, unguarded code path.

---

## 9. Tests

| Suite | Files | Tests | Result |
|---|---|---|---|
| New: `proficiencyPolicy.test.ts` | 1 | 25 | pass |
| New: `readiness.test.ts` | 1 | 20 | pass |
| New: `phase30SchemaFoundation.test.ts` | 1 | 10 | pass |
| New (added to existing files): 2 recommendations G1 tests + 1 assignments G1 test | — | 3 | pass |
| Edited (fixture level changed, not weakened): assignments.provenance/learnerAssignments/recommendations | 3 files | — | pass |
| Full capability + learning-assignment regression | 33 files | 666 | pass |
| Broader integration sweep (capability APIs, quiz/completion/grade routes, AI copilots, assignment view/UI) | 34 files | 560 | pass |
| **Full repository suite** | **171 files** | **3128** | **pass** (0 failed, 0 skipped) |

The full-suite number reconciles exactly with the known baseline: 3070 (end of Phase 29.3.4) + 55 new pure-module tests + 3 new G1 regression tests = 3128.

**Known pre-existing flake, unrelated to this phase:** `src/app/api/cron/downgrade-subscriptions/route.test.ts`'s "two runs executing at the same time downgrade a tenant exactly once" failed on 1 of 2 full-suite runs during this session (documented flake, ~30–40% rate, recorded before this phase began). It passed 3/3 when run in isolation immediately after. The reported final numbers above are from the clean run.

**Schema/migration tests, specifically (§16 of the task):**
- Additive behavior and old-row readability: proven by writing through the real, unmodified production writer (`recordSkillEvidenceOutcome`) and reading back both new-column defaults and pre-existing V1 fields on the same row.
- No destructive migration: every deprecated V1 column (`SkillEvidence.proficiency/score/metadata`, `UserSkill.confidence/targetProficiency/status`) still accepts a write.
- Tenant semantics: the one approved composite relationship (`UserSkill` vs `Skill`) is proven to reject a cross-tenant row and accept a same-tenant one, in the same test file, against the real database.
- Indexes/constraints use the approved safe strategy: proven empirically, not just asserted — the migration (including the `NOT VALID`/`VALIDATE CONSTRAINT` two-step) was actually applied and the FK is live and enforcing (§3).

**Tenant composite relationship test:** covered above — the one approved relationship, both directions (accept/reject).

---

## 10. Mutation results

No mutation-testing tool is installed (`fast-check`, Stryker, etc. — confirmed absent from `package.json`). Followed the repository's established manual mutation-script convention (Python, exact-string mutation, restore in `finally`, restoration verified by re-diffing after each run).

**18 mutants**, targeting exactly the five areas the task named: ceiling calculation, validity, contribution, assessability, readiness statuses (plus the two G1 guard call sites, since the task also requires regression tests "for the exact G1 case").

| Target | Mutants | Killed |
|---|---|---|
| `ceilingFor` | 2 | 2 |
| `isEvidenceValid` | 3 | 3 |
| `doesEvidenceContribute` | 1 | 1 |
| `confidenceFor` | 4 | 4 |
| `MAX_GRANTABLE_LEVEL` / `isAssessable` | 2 | 2 |
| `evaluateRequirement` (readiness) | 4 | 4 |
| G1 guard (`recommendations.ts`, `assignments.ts`) | 2 | 2 |
| **Total** | **18** | **18** |

**18/18 killed. No survivors. No equivalent mutants needed documenting** — every mutant that was considered a candidate for equivalence (for example, `doesEvidenceContribute`'s NONE-grant check, which is always redundant with validity *under Policy 1 specifically*) was instead written as a real behavioral mutation that a different, already-written test (the `projectProficiency`/`doesEvidenceContribute` tests) does catch, so no mutant needed to be excused. All mutated files were verified restored to their pre-mutation content after each run; the full pure-module suite (45 tests) was re-run clean after the batch completed.

---

## 11. Typecheck / build / schema validation

| Check | Result |
|---|---|
| `npx tsc --noEmit` | 0 errors |
| `npx biome check .` | 0 errors, 53 warnings (unchanged baseline; the pre-existing warnings are in files this phase never touched) |
| `npx prisma validate` | schema valid |
| `npx prisma generate` | regenerated cleanly against `lumio_test`; `src/generated/prisma/` updated accordingly (expected — this directory is checked into the repo per existing convention) |
| `git diff --check` | 0 (no whitespace errors) |
| `pnpm build` | production build succeeds; every existing route still listed, no new route added |
| Full test suite | 171 files, 3128 tests, 0 failed (one run hit the pre-existing cron flake; the reported numbers are the clean re-run) |

---

## 12. Files changed

**New (11):**
- `prisma/migrations/20260924100000_add_capability_proficiency_v2_foundation/migration.sql` (118 lines)
- `src/lib/domain/capability/proficiencyPolicy.ts` (200 lines)
- `src/lib/domain/capability/proficiencyPolicy.test.ts` (277 lines)
- `src/lib/domain/capability/readiness.ts` (72 lines)
- `src/lib/domain/capability/readiness.test.ts` (106 lines)
- `src/lib/domain/capability/phase30SchemaFoundation.test.ts` (302 lines)
- `docs/PHASE_30.1_IMPLEMENTATION.md` (this file)
- `src/generated/prisma/models/SkillProficiencyEvent.ts` (generated)
- Three Phase 30 discovery/contract/pre-flight docs from the prior turn, unchanged this turn: `docs/PHASE_30_CAPABILITY_PROFICIENCY_V2_DISCOVERY.md`, `docs/PHASE_30_CAPABILITY_PROFICIENCY_V2_CONTRACT.md`, `docs/PHASE_30_CAPABILITY_PROFICIENCY_V2_PREFLIGHT.md`

**Modified (8 source files, plus regenerated Prisma client):**
- `prisma/schema.prisma` (+193 lines: 3 enums, `SkillProficiencyEvent` model, additive columns on `SkillEvidence`/`UserSkill`, back-relations on `User`/`Tenant`/`Skill`/`SkillEvidence`)
- `src/lib/domain/capability/recommendations.ts` (+9/-2: the G1 guard, one import)
- `src/lib/domain/learning-assignment/assignments.ts` (+6: the G1 guard, one import)
- `src/lib/domain/learning-assignment/types.ts` (+4: the new skip-reason literal)
- `src/lib/learning-assignment-api.ts` (+1: the new skip-reason message-map entry)
- `src/lib/domain/capability/recommendations.test.ts` (+70/-14: two new G1 tests, four existing tests re-leveled)
- `src/lib/domain/learning-assignment/assignments.provenance.test.ts` (+28/-2: one new G1 test, two existing tests re-leveled)
- `src/lib/domain/learning-assignment/learnerAssignments.test.ts` (+5/-2: one existing test re-leveled)
- `src/generated/prisma/{browser,client,commonInputTypes,enums}.ts`, `internal/{class,prismaNamespace,prismaNamespaceBrowser}.ts`, `models.ts`, `models/{Skill,SkillEvidence,Tenant,User,UserSkill}.ts` — regenerated by `prisma generate`, not hand-edited.

**Total new/changed test count:** 45 (policy) + 20 (readiness) + 10 (schema foundation) + 3 (G1 regression) + 4 existing tests re-leveled = 82 tests touched or added this phase.

---

## 13. Explicitly deferred work

Per the task's own list, none of the following were implemented, and a grep-level check confirms no accidental leakage into this phase's diff:

- **30.2:** locked `UserSkill` recomputation, evidence aggregation runtime, proficiency event writes, baseline backfill, V1 reconciliation, Policy 1 cutover. (`recomputeUserSkill` does not exist; nothing calls `projectProficiency`/`confidenceFor` from any runtime path; `SkillProficiencyEvent` has zero rows.)
- **30.3:** recency behavior, confidence runtime updates, verification/invalidation semantic changes, rejection/revocation behavior changes. (`verification.ts` is unmodified; `state`/`validUntil` are never read by any production code path yet.)
- **30.4:** history read APIs/UI. (No new route, no new page.)
- **30.5:** complete readiness-consumer migration, new role readiness behavior. (The four existing `met` comparisons are byte-for-byte unchanged.)
- **30.6:** profile/recommendation migration beyond the scoped G1 guard. (No UI change; `getRecommendedLearning`'s response shape is unchanged.)
- **30.7:** analytics implementation. (Not touched.)
- **30.8:** assessor write path, INSTRUCTOR/ORG_ADMIN assessment authorization. (No new endpoint; `assessedLevel`/`supersededById` fields not added, per §2.)

---

## 14. Known risks

1. **`prisma migrate diff` will report the composite FK as extraneous** if the live database is ever diffed against `schema.prisma` (confirmed, §2/§9) — because the constraint is raw SQL, not a Prisma-modeled relation. A future contributor generating a migration with `prisma migrate dev` should not accept an auto-suggested `DROP CONSTRAINT "UserSkill_skillId_tenantId_fkey"` without recognizing this. Flagged in the migration file's own comment and here.
2. **This migration has been proven only against the local test database, not production.** The pre-flight audit's §0 caveat applies unchanged: no Neon access exists in this environment. The empirical success of `VALIDATE CONSTRAINT` here (§3) is strong evidence, not a production guarantee — pre-flight condition 1 (re-running the audit's tenant-integrity queries against production before the *other three* relationships are ever added) still stands for any future slice that touches them; this slice added only the one relationship already proven safe in both the audit's read-only query and this migration's real `VALIDATE CONSTRAINT`.
3. **`createCapabilityGapAssignment` has no live caller.** The G1 guard is correct and tested, but nothing in the current API surface exercises it in production traffic today (§7). This is a pre-existing condition of the codebase, not something this phase introduced or needs to fix, but it means the guard's real-world value is currently latent until/unless a route is added.
4. **Two pure modules (`proficiencyPolicy.ts`, `readiness.ts`) exist unconsumed by production code.** This is by design for 30.1, but it is worth naming as a risk in the ordinary sense that unused code can drift from its own tests if left alone for a long gap before 30.2 begins. The mutation-testing result (§10) is the mitigation: the modules are proven correct in isolation, independent of when they are wired in.

---

## 15. Final status

```text
PHASE_30.1 COMPLETE
```
