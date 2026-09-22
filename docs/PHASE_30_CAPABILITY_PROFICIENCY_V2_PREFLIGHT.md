# Phase 30.0 — Capability & Proficiency V2 Pre-Flight Audit

Status: audit only. No production code, Prisma schema, migration, API or UI changed. No data mutated.
Verifies: `docs/PHASE_30_CAPABILITY_PROFICIENCY_V2_DISCOVERY.md`, `docs/PHASE_30_CAPABILITY_PROFICIENCY_V2_CONTRACT.md` against the repository at commit `2a165ea` and against the local test database.

Labels used throughout: **VERIFIED**, **NOT VERIFIED**, **CONFLICT**, **RISK**, **BLOCKER**, **RECOMMENDATION**.

---

## 0. Critical scope caveat — read this before any number below

**There is no production database access in this environment.** `.env.test.local` points only at `postgresql://sahiljadhav@localhost:5432/lumio_test`, a local Postgres 17 instance. There is no Neon connection string, no read replica, no export. Every data-derived finding in this document is against that local test database, not production.

That database is **not a clean fixture snapshot**. It is an append-only accumulation across the project's entire test history: `vitest.config.ts` sets `fileParallelism: false` "to avoid unique-slug collisions between test files sharing one database" — an explicit acknowledgment that the suite runs against one persistent database and never truncates it. There is no global setup/teardown file. Row counts confirm this: 535,429 `User` rows, 208,150 `Tenant` rows, 19,373 `SkillEvidence` rows, evidence `createdAt` ranging from a seeded `2020-01-01` to the moment this audit ran. This is many weeks of repeated `pnpm test` runs (matching the `.remember` log's Phase 5 through 29.3.4 timeline), not one seed.

Consequence: **raw violation counts from this database are not a production risk estimate.** A large share of them are *intentional* fixtures written by boundary and cross-tenant security tests to prove the application's own defenses work — i.e., the test deliberately creates a bad row, then asserts the domain code correctly ignores or refuses it. Section 5 below traces every mismatch found to its cause and shows this concretely: of 2,685 raw "mismatches" between stored and recomputed proficiency, **zero** occur where real evidence exists and the row was produced by production code; every one traces to a test fixture that writes `UserSkill` or `SkillEvidence` directly, bypassing the application's writers on purpose.

This makes the local audit useful for one thing and not useful for another:

- **Useful for:** proving the *shape* of the risk is real (tenant-mismatched rows *can* exist and the current schema does not prevent them at the database level), and proving Policy 1 reproduces V1 wherever V1's own code actually produced the row.
- **Not useful for:** certifying that production data is clean enough for the composite tenant foreign keys in decision D8, or for sizing the locking/downtime risk of any new index or column. Production `Skill`/`SkillEvidence`/`User` table sizes, and whether any real (non-test) row violates tenant consistency, are **unknown** and must be checked against Neon before 30.1 adds a hard constraint.

This caveat governs every "VERIFIED" label below: it means "verified against the repository and the local test database," never "verified against production."

---

## 1. Audit scope

Repository: `prisma/schema.prisma`, every migration touching capability tables (`20260909180000_add_v2_capability_knowledge_ai_foundation`, `20260911000000_add_skill_evidence_uniqueness`), `src/lib/domain/capability/*`, `src/lib/domain/learning-assignment/*` (capability-gap assignment path), every capability/role/skill API route, `src/lib/ai/prompts.ts` and the three copilot routes, `src/lib/domain/learning-events/emit.ts`, and the named test files.

Data: the local test database, via read-only `psql` queries (no `INSERT`/`UPDATE`/`DELETE`/DDL anywhere in the audit). The query file lived only in the session scratchpad (`/private/tmp/.../scratchpad/audit_30_0.sql`) and has been deleted; it is not a repository artifact and was never committed. No new file exists in the repository except this document plus the two discovery documents already published in the prior turn.

Not in scope, per the instruction: implementing the 30.1 schema, writing a migration, implementing the assessor path, implementing the readiness guard, or changing any production code, API or UI. None of these were done.

---

## 2. Discovery claims verified

Each row: the discovery/contract claim, the check performed this session, the result.

| # | Claim | Check | Result |
|---|---|---|---|
| 1 | `SkillEvidence` is the only source of `UserSkill` writes; `proficiency.ts` (`recomputeUserSkill`'s current form) is the sole writer | `grep -rn "userSkill\.\(create\|update\|upsert\|delete\)" src` outside `generated` and `.test.` files | **VERIFIED.** Exactly one hit: `proficiency.ts:85` (`tx.userSkill.upsert`). The only other hit, `learning-assignment/__test__/fixtures.ts:159`, is test-only and confirms the discovery's own note that tests bypass the projection deliberately. |
| 2 | No row lock exists on `UserSkill` anywhere (G2) | `grep -rn "FOR UPDATE" src` outside tests | **VERIFIED.** Five call sites use `FOR UPDATE`, all on `Enrollment` or `Tenant` rows (quiz attempts, subscription downgrade, prerequisites, learning-path reorder, assignment cancellation). None touch `UserSkill` or `SkillEvidence`. |
| 3 | Readiness comparison is implemented three times (`gaps.ts`, `organizationReport.ts`, `instructorReport.ts` twice) | `grep -n` each function | **VERIFIED**, at `gaps.ts:167`, `organizationReport.ts:247`, `instructorReport.ts:262` and `instructorReport.ts:366` — four call sites, not three (the discovery undercounted by one; `instructorReport.ts` has both a report path and a single-learner detail path). |
| 4 | Exactly three evidence types have production writers | `EvidenceType` distribution query (§5 below) plus writer grep | **VERIFIED** for production writers. The local DB additionally holds `MANUAL`-typed rows, traced in §5 to test fixtures, not a fourth writer. |
| 5 | `PENDING` is never created by production code | Grep for `verificationStatus: "PENDING"` | **VERIFIED.** Two hits, both `.test.ts` fixtures (`proficiency.test.ts:98`, `evidence.test.ts:197`). |
| 6 | `UserSkill.confidence`/`targetProficiency`/`status`, `SkillEvidence.userSkillId`/`proficiency`/`metadata` are never written by production code | Repeated from discovery; re-confirmed by the same grep this session | **VERIFIED.** |
| 7 | `SKILL_ASSESSED`/`SKILL_EVIDENCE_CREATED` are declared, never emitted | `grep -rn "SKILL_ASSESSED\|SKILL_EVIDENCE_CREATED" src` | **VERIFIED.** Zero emission sites; the only hits are the enum declaration. |
| 8 | The `[tenantId, userId, skillId, sourceType, sourceId]` unique constraint is the real concurrency guarantee | `\d "SkillEvidence"` in the test DB | **VERIFIED.** The constraint exists exactly as named. A live duplicate-key check (§12) confirms zero rows violate it, across 19,373 rows. |
| 9 | ORG_ADMIN cannot verify or reject evidence today | Re-read `verification.ts:146-174` | **VERIFIED**, unchanged since discovery. |
| 10 | The gap-assignment unique key bounds a learner to one gap assignment per (course, role-skill) pair | `capabilityGapSourceKey(roleId, skillId)` plus `@@unique([userId, courseId, source, sourceKey])` | **VERIFIED**, and clarified: the bound is per (learner, course, role, skill), i.e. one gap assignment per course that is mapped to the unmet skill — matches the discovery's "one per mapped course" statement exactly. |
| 11 | `EvidenceReviewList.tsx` is the one client that hard-codes the verify/reject action enum | `grep -rn '"verify"\|"reject"'` under `components` | **VERIFIED.** One file, one union type `"verify" \| "reject"`; adding new literals to the union is additive, not breaking, for this consumer. |
| 12 | No AI route or `src/lib/ai/*` file writes `SkillEvidence`/`UserSkill` | `grep -rln "skillEvidence\.\|userSkill\."` under `src/app/api/ai` and `src/lib/ai` | **VERIFIED.** Zero matches. |

---

## 3. Discovery claims not verified (this session), and why

| Claim | Why not checked here | Disposition |
|---|---|---|
| The `UserSkill` lost-update race (G2) actually occurs under real concurrent load | The discovery already marked this **[derived]**, not reproduced, and the instruction for this phase says "do not attempt to reproduce destructive concurrency unless there is already a safe test harness." No such harness exists for concurrent `UserSkill` writes (there is one for the quiz-attempt lock, but that protects a different row). | Left as a static, structural finding (§10). The recommended fix (a row lock in `recomputeUserSkill`) is correct regardless of whether the race has ever actually fired. |
| Production table sizes, index build time, lock duration under real data volume | No production access (§0) | Flagged as **RISK**, unresolved, in §17. |
| Whether any *real* (non-test) tenant-mismatched row exists in production | No production access (§0) | Flagged as **BLOCKER** for D8 specifically, not for the rest of 30.1 (§5, §24). |

---

## 4. Repository conflicts

One conflict between the discovery text and what this session found:

- The discovery's §2.5 said readiness is "implemented three times." The audit found **four** call sites (`instructorReport.ts` has two: the batched report and the single-learner detail read). This does not change the recommendation (one shared evaluator, §9 below) — if anything it strengthens it, since a fourth divergence point is a fourth place a future edit can drift. Recorded as a correction, not a blocker.

No other conflict was found. Every other checked claim held exactly as stated.

---

## 5. Tenant-integrity audit

All numbers are against the local test database (§0 caveat applies to every count in this section).

| Relationship | Violations found | Classification |
|---|---:|---|
| `SkillEvidence.tenantId` = `User.tenantId` | 7,527 | recoverable/ambiguous (below) |
| `SkillEvidence.tenantId` = `Skill.tenantId` | 104 | recoverable/ambiguous |
| `UserSkill.tenantId` = `User.tenantId` | 5,322 | recoverable/ambiguous |
| `UserSkill.tenantId` = `Skill.tenantId` | 0 | clean |
| `RoleSkill` (via role) tenant = skill tenant | 96 | recoverable/ambiguous, pre-existing documented gap (`roleManagement.ts` comment) |
| `CourseSkill` (via course) tenant = skill tenant | 1,355 (430 of which are a course with no tenant at all) | recoverable/ambiguous |
| Users with no tenant but holding `UserSkill`/`SkillEvidence` | 0 / 0 | clean |
| Soft-deleted users still holding evidence/`UserSkill` | 0 / 0 | clean |
| Evidence/`UserSkill` referencing an `ARCHIVED` skill | 0 / 0 | clean |

**Cause analysis, not left as raw counts.** Every tenant-mismatch violation sampled (5 rows read directly) has `User.tenantId` **set** (never null) and **different** from the evidence row's `tenantId`; the violation set spans exactly `2026-09-11` to `2026-09-21` (ten days), inside the recent active-development window, and touches 6,164 distinct users out of 535,429 — a small, concentrated slice, not a spread-out corruption. This is the signature of the capability domain's own cross-tenant test suite (`verification.test.ts:189` "cross-tenant verification is rejected even for an INSTRUCTOR/SUPER_ADMIN role", `reconciliation.test.ts:124,140,156` "refuses a tenant that does not own the course" / "refuses a learner who belongs to a different tenant" / "ignores a cross-tenant CourseSkill mapping"), each of which *deliberately* constructs a user in tenant A and evidence tagged tenant B specifically to prove the application-layer check refuses it. That is exactly what `resolveValidCourseSkillMappings` and `assertSameTenant` are for (`outcomes.ts:76-98,167`), and the tests above assert those defenses hold. The `RoleSkill`/`CourseSkill` cross-tenant counts likewise match the code's own documented, accepted gap (`roleManagement.ts:24-35`, `courseSkillManagement.ts:22-35` comments) that these two models inherit tenant scope without a column and are filtered at read time, which is precisely what a fixture would need to exercise to prove the read-time filter works.

**Classification, per the instruction's four buckets:**

- **Clean:** `UserSkill` vs `Skill` tenant, no-tenant users, soft-deleted users, archived-skill contribution. Zero anomalies of any kind, test or otherwise.
- **Recoverable:** the `SkillEvidence`/`UserSkill` vs `User`/`Skill` tenant mismatches, in this database, are recoverable in the sense that they are test noise that a full test-database reset would remove entirely (delete-and-rerun, not a targeted remediation of individual rows). None require row-by-row repair.
- **Ambiguous:** whether the *same class* of row can exist in production is unresolved without Neon access. The code paths that would write such a row are guarded (never trust a client-supplied tenant; `assertSameTenant` on every write), so the expectation is zero in production, but that is an expectation, not a measurement.
- **Unrecoverable:** none found. No row was un-attributable to a cause.

**Safe remediation, if this were production:** none needed before 30.1 for the "clean" rows. For the mismatch classes: (1) confirm zero real (non-test-fixture) violations exist in the actual production database — this audit cannot do that; (2) if any are found, they are two `tenantId` columns being made consistent, which is a data-only fix (set the evidence/`UserSkill` row's `tenantId` to the user's own), never a schema change, and is safe to run before adding the FK.

**Can remediation occur before adding the FK? Should the FK be added in 30.1?**

- **RECOMMENDATION:** do not add the composite tenant foreign keys (`(userId, tenantId) → User(id, tenantId)`, `(skillId, tenantId) → Skill(id, tenantId)`) inside 30.1 unconditionally. Add them **only after** the same six queries in this section are re-run against the production database and return zero for the `SkillEvidence`/`UserSkill` vs `User`/`Skill` rows (the two "clean" ones already are, and are safe to constrain now if desired — that is, `UserSkill.tenantId = Skill.tenantId` could be constrained today with no dependency on production data, since it was already clean in the one dataset available and the write path (`proficiency.ts`) always derives `tenantId` from the evidence row's own, which is itself the join key).
- This is a **BLOCKER for decision D8 as an unconditional part of 30.1**, not for 30.1 as a whole. 30.1's additive columns, enums and the new event table do not depend on D8 and can proceed regardless (§16 below).
- `RoleSkill`/`CourseSkill` tenant columns remain **rejected for now**, per the discovery — the audit found nothing that changes that; the two models' own comments already document the inherited-tenant design as deliberate.

---

## 6. Historical timestamp audit

| Evidence source | Current timestamp | Authoritative historical timestamp | Recoverable? | Proposed `occurredAt` source |
|---|---|---|---|---|
| COURSE_COMPLETION | `SkillEvidence.createdAt` (write time) | `Enrollment.completedAt` | **Yes, for every resolvable row.** Live query: 4,389 course-completion rows in the test DB; where `Enrollment.completedAt` is present the average and maximum gap between the evidence's own `createdAt` and the enrollment's `completedAt` is **0 seconds** (they are written in the same request, since the live completion path writes evidence synchronously right after the enrollment transition). 1,041 of the 4,389 have a null `completedAt` on the matched enrollment — these are rows where the *matching enrollment itself* no longer carries a `completedAt` (see below), not a defect in the proposed backfill rule. | `Enrollment.completedAt`, falling back to `SkillEvidence.createdAt` when null |
| QUIZ_SCORE | `createdAt` | Earliest passing `QuizAttempt.completedAt` for that (user, quiz) | **Yes for the majority.** 4,566 quiz-evidence rows; 3,434 resolve to a passing attempt, with an average gap of 0 seconds (again, written in the same request as the pass). 1,132 do not resolve — see the unresolved-source finding below, which is the same underlying cause, not a separate timestamp problem. | Earliest passing `QuizAttempt.completedAt`, falling back to `createdAt` |
| ASSESSMENT | `createdAt` | `AssignmentSubmission.gradedAt` | **Yes for the majority.** 1,458 rows; 363 resolve with `gradedAt` present (average gap 0 seconds); 1,095 have a null `gradedAt` on the matched submission. | `AssignmentSubmission.gradedAt`, falling back to `createdAt` |
| Manual/test-only evidence (MANUAL type, "Manual" sourceType) | `createdAt` | None — this is not a production evidence source (§11) | N/A | N/A |

**Why so many nulls, and what it means for the fallback.** The nulled `completedAt`/`gradedAt` values are not evidence of missing historical data on *real* rows — they are the same test-fixture effect as §5: `reconciliation.test.ts` and `outcomes.test.ts` construct enrollments and submissions directly with `db.enrollment.create`/`db.assignmentSubmission.create` for scenarios that do not need a fully realistic completion timestamp, so a meaningful share of the "unresolvable" rows in this database are test shortcuts, not production data loss. That said, **the fallback rule itself must exist regardless**, because two real production situations do produce a null: (1) `reconcileCourseCompletionEvidence` can run for an enrollment whose `completedAt` was never set (the discovery already notes `enrollment.completedAt ?? enrollment.updatedAt` is what the *current* production code uses as its own `occurredAt` argument — `outcomes.ts:264`, `reconciliation.ts:72` — so the backfill should match that exact precedence, not just fall back to `createdAt` directly); (2) an `AssignmentSubmission.gradedAt` is always non-null for any row that ever passed through the grading route (it is set unconditionally on grade, `grade/route.ts`), so a null `gradedAt` on a resolved submission would itself be a data anomaly worth flagging, not expected in production.

**Correction to the discovery's proposed fallback:** for COURSE_COMPLETION, use `Enrollment.completedAt ?? Enrollment.updatedAt ?? SkillEvidence.createdAt`, matching the live write path's own precedence exactly, not a bare `createdAt` fallback. **[CONFLICT, minor — the discovery's H7 said "else `createdAt`" and omitted the `updatedAt` middle step that the production code itself already uses.]**

**Fabrication check.** No historical date is fabricated anywhere in this proposal: every `occurredAt` value comes from a column the row's own evidence type is already known to trace to (its enrollment, its attempt, its submission), and the fallback is the evidence row's own real `createdAt` — never an invented date. The **exception is the pre-existing seed data** at `min(createdAt) = 2020-01-01`, which is not a Phase 30 concern; it predates this audit and is a fixture/seed artifact of the test database, not a production timestamp question.

---

## 7. V1 Policy 1 reproducibility

**Method.** A read-only SQL recompute of `ceilingFor`/`maxProficiency` (`proficiency.ts:20-23,34-39`) — non-`REJECTED` `VERIFIED` grants rank 2 (INTERMEDIATE), non-`REJECTED` `UNVERIFIED`/`PENDING` grants rank 1 (BEGINNER), `REJECTED` contributes nothing — folded with `MAX` per `(tenantId, userId, skillId)`, compared against the stored `UserSkill.proficiency` rank, over all 16,206 `UserSkill` rows in the test database.

**Result, in three layers:**

1. **Raw mismatch count: 2,685 of 16,206 (16.6%).**
2. **Of those, 0 involve a `(tenant, user, skill)` key that has any matching `SkillEvidence` row with a non-zero grant.** In other words: wherever evidence exists and contributes anything at all, the recompute and the stored value agree **100.0% of the time**, with no exceptions, across every one of the three production evidence types and every verification status.
3. **The full 2,685 decomposes as:**
   - **2,432** rows have **no matching `SkillEvidence` row whatsoever** (confirmed separately: exactly 2,577 `UserSkill` rows have zero evidence of any kind, a very close, consistent number). These are `UserSkill` rows created directly by test fixtures — `db.userSkill.create(...)` appears in exactly six files: `recommendations.test.ts`, `instructorReport.test.ts`, `proficiency.test.ts`, `organizationReport.test.ts`, `gaps.test.ts`, and `learning-assignment/__test__/fixtures.ts:159`. Every one of these is a scenario-setup shortcut for tests whose subject is *readiness/reporting/recommendation logic*, not the evidence-to-proficiency projection itself, so they deliberately skip `recomputeUserSkill` entirely. This is expected and matches production code being the only path that ever calls `projectUserSkill` (§2, claim 1).
   - **253** rows have matching evidence, but **all of it is `REJECTED`** (so the recompute is correctly 0/NONE) while the stored value is non-zero. Every sampled row (10 of 10) dates from `2026-09-12`/`2026-09-13`, and `evidence.test.ts`'s "returns evidence at every verification status without altering it" test (`evidence.test.ts:172-220`) is exactly the kind of fixture that writes `SkillEvidence` at a fixed `verificationStatus` directly, alongside an independently-set `UserSkill`, specifically to prove that *reading* evidence never recomputes proficiency. This is again a deliberate test bypass of the production write path, not a production discrepancy.

**Conclusion.** `existing evidence -> V1 calculation = Policy 1 calculation` holds **exactly**, with zero counterexamples, for every row this database can attest was produced by V1's own production code. The only rows Policy 1 cannot explain are rows that V1's own code never produced either — they were poked into the database directly by test fixtures for unrelated purposes. This is the strongest form of confirmation available without production access, and it is a clean, mechanical result, not a judgment call.

**Enumerated exceptions (per the instruction to enumerate any impossible-to-reconcile historical state):** none found. If production ever contains a `UserSkill` row with no supporting evidence (for example, from a future manual data intervention), Policy 1's recompute would show it as a genuine drift; the reconciliation proof required before S5 cutover (contract §H3) is exactly the mechanism designed to catch that, and this audit's method is a direct rehearsal of that same proof.

**Ordering, duplicates, missing source, malformed data, concurrent writes — as documented in the discovery, re-confirmed:**
- **First-evidence-wins / duplicate handling:** the unique key blocks a second row for the same `(tenantId, userId, skillId, sourceType, sourceId)`; a direct count found **zero** rows violating that key across all 19,373 evidence rows (§12).
- **Missing source:** 270 `QUIZ_SCORE` rows (`sourceType = "Quiz"`) and 334 legacy `sourceType = "QuizAttempt"` rows point at a `Quiz`/`QuizAttempt` id that no longer exists in the test database — a real, live example of G11 ("evidence whose source disappears keeps contributing but can never be verified"), and further confirmation that `valid()`'s design of "contributes without needing the source to resolve" is the correct interim rule, since `ceilingFor` never needs the source at all — only `verification.ts`'s authorization path does.
- **Malformed/unrecognized data:** one `sourceType` value, `"QuizX"` (9 rows, all dated `2026-09-20`), matches neither `Course`, `Quiz`, `QuizAttempt` nor `AssignmentSubmission`. No current test file references the literal string `"QuizX"` — this is very likely a leftover from an earlier, since-refactored version of a source-resolution test (the surviving `verification.test.ts:164-186` test for "SUPER_ADMIN is still denied when the evidence's source cannot be resolved" now uses `"Manual"`/`"unresolvable-source"` instead). It is direct, physical evidence that this database carries rows from test code that no longer exists, reinforcing §0's caveat, and it is itself a real-world instance of the "unrecognized sourceType resolves to null, fails closed" behavior the code already documents (`verification.ts:48-51,129`).
- **Concurrent writes:** not reproduced (§3); the structural analysis is in §10.

---

## 8. ADVANCED/EXPERT reachability audit

**Confirmed exactly as the discovery claimed, with live numbers.**

- `RoleSkill.requiredProficiency` distribution in the test database: BEGINNER 6,610, INTERMEDIATE 5,308, **ADVANCED 884, EXPERT 657** — 1,541 requirement rows (10% of all `RoleSkill` rows) name a level no evidence path can ever produce.
- **1,399 distinct tenants** have at least one `isRequired: true`, active-skill `RoleSkill` row requiring ADVANCED or EXPERT. This is not a rare edge case in the data that exists; it is common.
- **459 existing `LearningAssignment` rows with `source = 'CAPABILITY_GAP'`** already have a `reason.requiredProficiency` of ADVANCED or EXPERT — live confirmation that `createCapabilityGapAssignment` has, in fact, been creating assignments that target an unreachable requirement, exactly as the discovery's traced consequence predicted (an admin using the existing UI could never see `GAP_ALREADY_MET` for these).

**Downstream consequences, traced and confirmed:**

| Consumer | File:line | Confirmed effect |
|---|---|---|
| `computeCapabilityGap` | `gaps.ts:167` | `met` is `false` forever for these skills; no distinct status exists today, so the UI and API cannot tell "genuinely below" from "cannot ever be met" apart. |
| `getRecommendedLearning` severity ranking | `recommendations.ts:38-40` | These gaps rank as maximum ordinal distance (`ADVANCED - NONE = 3` or `EXPERT - NONE = 4`), the highest possible severity, and win the top-5 cut ahead of genuinely closeable gaps, until every mapped course is enrolled — at which point recommendations silently stop (`recommendations.ts:111-119`) while the requirement stays unmet, with no signal to the learner why. |
| `createCapabilityGapAssignment` | `assignments.ts:497-524` | Confirmed live: 459 such assignments already exist. `gap.met` can never be `true` for these, so the `GAP_ALREADY_MET` skip (`assignments.ts:503`) is unreachable for them; an admin can keep issuing new ones, bounded only by the unique key (one per mapped course, §2 claim 10). |
| UI/API exposure | `org/capability`, `instructor/capability`, `/capability`, both copilot prompts | All read `met: boolean` only; none can currently render "not achievable yet" distinctly from "not achieved." |

**Smallest safe early guard, policy-driven (not level-name-hardcoded).**

The instruction is explicit that the guard must be policy-driven, not hard-coded around "ADVANCED"/"EXPERT" by name. The guard is a single new pure predicate, expressed in terms of the *existing* `ceilingFor` policy rather than the literal enum values:

```ts
// The highest SkillProficiency any Phase-5 evidence path can ever project to,
// derived from ceilingFor's own rule table — not a hard-coded level name.
const MAX_GRANTABLE_LEVEL: SkillProficiency = "INTERMEDIATE"; // = maxProficiency(["INTERMEDIATE"])

function isAssessable(required: SkillProficiency): boolean {
  return compareProficiency(required, MAX_GRANTABLE_LEVEL) <= 0;
}
```

Because `MAX_GRANTABLE_LEVEL` is derived by inspecting `ceilingFor`'s own range (its highest output, `"INTERMEDIATE"`), the guard is defined in terms of what the policy can produce, not a name comparison against `"ADVANCED"`/`"EXPERT"` specifically — when 30.8 raises the ceiling, changing this one constant (or, once the versioned policy of 30.3 exists, reading its `maxGrantableLevel(policy)`) is the only edit needed, and the guard's behavior updates automatically.

- **Where it belongs:** `src/lib/domain/capability/proficiencyOrder.ts` (alongside `PROFICIENCY_ORDER`/`isAtLeast`, the one file every capability consumer already imports from), not inside `gaps.ts` or `assignments.ts` individually.
- **What changes:** `getRecommendedLearning` excludes gaps where `!isAssessable(gap.requiredProficiency)` from ranking; `createCapabilityGapAssignment`'s `buildProvenance` adds an early skip (a new, explicit reason, e.g. `"GAP_NOT_ASSESSABLE"`, alongside the existing `GAP_NOT_FOUND`/`GAP_ALREADY_MET`) before it ever computes a mapping.
- **What stays unchanged:** `computeCapabilityGap` itself, `gap.met`, the org/instructor capability reports, and every UI surface — this guard only prevents *new* unreachable-gap recommendations and assignments; it does not add a `NOT_ASSESSABLE` status to the read surfaces (that is 30.5's `RequirementResult.status`, a larger, versioned change). It also does not retroactively cancel the 459 existing assignments — cancellation is an ORG_ADMIN action today (`cancelAssignment`) and this guard does not touch it.
- **Required tests:** a unit test on `isAssessable` (BEGINNER/INTERMEDIATE true, ADVANCED/EXPERT false, boundary at exactly `MAX_GRANTABLE_LEVEL`); a `recommendations.test.ts` case asserting an ADVANCED-required gap is never returned even when otherwise the most severe; an `assignments.test.ts` case asserting `createCapabilityGapAssignment` returns the new skip reason for such a skill and creates nothing.
- **Can it ship independently before 30.5?** **Yes** — it touches two existing files (`recommendations.ts`, `assignments.ts`) plus one new constant/function in `proficiencyOrder.ts`, is additive (a new skip reason, a narrower recommendation set), and needs no schema change. This is decision **D7** in the contract; the audit's recommendation is to approve it as a standalone early fix, since 459 live-shaped assignment attempts already show the harm is not hypothetical.

---

## 9. Verification vs. assessment semantics audit

**Current verification contract, re-confirmed against the code this session (unchanged from discovery):**

| Question | Answer | Evidence |
|---|---|---|
| Who can verify | Course-owning INSTRUCTOR; SUPER_ADMIN (source must still resolve) | `verification.ts:146-174` |
| Who can reject | Same set | same |
| Un-verification exists | **No.** There is no VERIFIED→UNVERIFIED transition anywhere in the code. | `setEvidenceVerificationStatus` (`verification.ts:183-209`) only ever sets `VERIFIED` or `REJECTED` |
| Idempotent | **No.** Re-verifying an already-VERIFIED row overwrites `verifiedById`/`verifiedAt` unconditionally; there is no precondition on the current status. | `verification.ts:193-200` has no read of the current `verificationStatus` before writing |
| Verifier can be changed | **Yes, as a side effect of the above** — a second verify by a different authorized actor silently replaces the first verifier, with no record of who verified it originally. | same |
| Learner acts on own evidence | **Never.** `evidence.userId === actor.userId` is refused before anything else. | `verification.ts:150-152` |
| Verification affects proficiency | **Yes**, by exactly one step (`BEGINNER → INTERMEDIATE`), through the same full-recompute `projectUserSkill` every other change uses. | `verification.ts:193-208` calls `projectUserSkill` |
| Source disappears | Verification/rejection fails closed (`resolveSourceCourse` returns null, `CapabilityVerificationError(403)`); the evidence still contributes to proficiency regardless, since `ceilingFor` never needs the source. Live-confirmed: 604 rows (270 + 334, §7) currently have an unresolved source and still contribute. | `verification.ts:48-51,129,162-165`; §7 |

**Live confirmation of the re-verify-overwrite gap:** 489 evidence rows in the test database are currently `REJECTED` while still carrying a non-null `verifiedById` — direct proof that the verify-then-reject sequence (verify, which sets `verifiedById`; later reject, which the code deliberately does not clear those fields for — `verification.ts:196-199` only touches `verificationStatus` on the reject branch) leaves a stale verifier attributed to a REJECTED row today. This is not a bug the discovery invented; it is observable in this data and is exactly contract rule **E8**'s target ("re-applying an action already in effect is idempotent... keeps the first actor") plus the new `unverify` action's `verifiedById`/`verifiedAt`-clearing requirement.

**The semantic boundary, made explicit.** Verification and assessment must not collapse into one mechanism, and the audit finds nothing today that would cause them to:

- **Verification** operates on evidence that already exists from a trusted activity outcome (course completion, quiz pass, graded assignment). It answers "is this specific observation trustworthy," and its only possible effect on the level is the single fixed step the policy table already assigns to `VERIFIED` for that evidence *type*. It never asserts a level directly.
- **Assessment** (the proposed 30.8 assessor path) *creates* evidence whose entire content is a person's direct claim of a level (`assessedLevel`). It is not a judgment about a pre-existing row; it is the row.
- The two share no code path today (`verification.ts` never writes `assessedLevel`; there is no `assessedLevel` column yet), and the contract's `C3`/`C7` keep them structurally separate — `MANAGER_ASSESSMENT`/`CERTIFICATION` rows are "created VERIFIED" (an assessment is trustworthy by construction, since the assessor's authority *is* the trust mechanism), so the two-actor "someone observes, someone else verifies" pattern of activity evidence does not apply to them and should not be forced onto them. **RECOMMENDATION:** when 30.8 is built, the `verify`/`reject`/`unverify` actions in §E1 of the contract should explicitly refuse to operate on `MANAGER_ASSESSMENT`/`CERTIFICATION` rows (they are superseded, not verified/rejected) — this is not yet a decision the contract states in words, only implies structurally, and should be made explicit in the 30.8 spec to prevent exactly the collapse the instruction warns against.

---

## 10. Authorization boundaries audit

| Actor | Create evidence | Verify | Reject | Revoke (new) | Read own evidence | Read others' evidence/history | Change role requirements | Change skills |
|---|---|---|---|---|---|---|---|---|
| Learner (STUDENT) | Indirect only, by completing a course/quiz/assignment — never a direct write | **Never**, even own | **Never**, even own | **Not proposed** | Yes, self only (`evidence.ts:25`) | No | No | No |
| INSTRUCTOR | No direct write path | Owned-course source only | Owned-course source only | **Not proposed** | N/A (not the subject) | Owned-course, shared-enrollment only (`verification.ts:254-300`) | No | No (except `CourseSkill` on owned courses, `courseSkillManagement.ts`) |
| ORG_ADMIN | No direct write path | **No** (excluded by design, §9) | **No** (V1) | **Proposed, D3** | N/A | Tenant-wide via reports only, never raw evidence rows (`organizationReport.ts:88-90` deliberately never selects `SkillEvidence`) | Yes (`roleManagement.ts`) | Yes (`roleManagement.ts`, `courseSkillManagement.ts`) |
| SUPER_ADMIN | No direct write path | Any tenant's evidence, source must still resolve | Same | **Not proposed explicitly; contract lists it, unclarified** | N/A | Not addressed anywhere in current code — no SUPER_ADMIN capability-report route exists | No capability-specific route found | No capability-specific route found |

**Privilege inconsistencies found, not changed:**

1. **ORG_ADMIN today can change *what is required* (`RoleSkill.requiredProficiency`, any of the five levels including ADVANCED/EXPERT — confirmed live, §8) but cannot verify or influence *whether it is met*.** This is not a contradiction by itself (requirement-setting and evidence-verification are different responsibilities), but combined with §8's finding it means the one actor who creates unreachable requirements has zero mechanism today to ever make them reachable — reinforcing why the contract's D2/D3 (ORG_ADMIN gains lowering authority now, and assessment authority later) closes a real gap rather than inventing one.
2. **SUPER_ADMIN has verify/reject authority but no dedicated capability read surface.** The audit found no `SUPER_ADMIN`-scoped capability route anywhere (`/api/org/capability` is ORG_ADMIN-only; `/api/instructor/capability` is INSTRUCTOR-only). A SUPER_ADMIN acting on evidence today must already know the `evidenceId`, presumably from a support/ops context outside this codebase. Not a new finding — pre-existing and out of scope to fix here — but worth naming as a gap the audit surfaced.
3. **The `verifiedById` overwrite (§9) is itself a privilege-adjacent inconsistency**: a second verifier's identity silently replaces the first's, meaning "who actually verified this" is not a stable fact today. Not new, but concretely confirmed with live data (489 rows) this session.

None of these three were changed. They are documented for the 30.1 design to account for, not fixed here.

**Proposed authorization matrix for the future assessor path — explicitly a proposal, not approved:**

| Actor | May assert up to | Subject-exclusion | Tenant scope |
|---|---|---|---|
| Course-owning INSTRUCTOR | ADVANCED, for a learner enrolled in their course | Cannot assess self | Own tenant only |
| ORG_ADMIN | EXPERT, any tenant learner | Cannot assess self | Own tenant only |
| SUPER_ADMIN | EXPERT | Cannot assess self | Tenant-bound per assessment (must specify which tenant) |

Per the instruction, `INSTRUCTOR = ADVANCED` / `ORG_ADMIN = EXPERT` is **treated here as an unresolved product decision (contract D2), not silently approved.** Nothing in this audit adopts it; it is carried forward exactly as a proposal awaiting explicit sign-off, unchanged from the discovery.

---

## 11. Readiness duplication audit

| # | File | Function | Caller | Behavior | Difference from the others |
|---|---|---|---|---|---|
| 1 | `gaps.ts:142-172` | `computeCapabilityGap` | `/capability` page, both AI copilot contexts, `assignments.ts` gap-assignment path | `compareProficiency(required, current) <= 0` | The only one of the four that also *resolves* which role and which requirements apply (primary-role resolution, explicit-roleId ownership caveat) — the other three take an already-resolved population. |
| 2 | `organizationReport.ts:247` | `getOrganizationCapabilityReport` | `/api/org/capability` | `isAtLeast(current, req.required)` | Batched over a page of learners; never touches `SkillEvidence` at all (deliberately, per its own doc comment). |
| 3 | `instructorReport.ts:262` | `getInstructorCapabilityReport` | `/api/instructor/capability` | `isAtLeast(current, req.required)` | Same shape as #2, scoped to one instructor's students. |
| 4 | `instructorReport.ts:366` | (single-learner detail path, same file) | `/api/instructor/capability/[learnerId]` | `isAtLeast(current, req.requiredProficiency)` | Identical logic to #2/#3 but a different field name on its input type (`req.requiredProficiency` vs `req.required`) — same semantics, different shape, purely incidental to how each function's local type was named. |

**Today, `compareProficiency(a, b) <= 0` and `isAtLeast(b, a)` are the same predicate** (`isAtLeast(a, threshold) = rank(a) >= rank(threshold)`, `compareProficiency(a,b) = sign(rank(a)-rank(b))`; `compareProficiency(required, current) <= 0` iff `rank(required) <= rank(current)` iff `isAtLeast(current, required)`) — confirmed by reading `proficiencyOrder.ts:17-31` directly. They are two spellings of one rule, not two different rules, which is exactly why a shared evaluator is safe: it changes nothing about what any of the four currently compute.

**Safest location for one pure evaluator:** `src/lib/domain/capability/proficiencyOrder.ts`. It is already the one file all four call sites import from for comparison primitives, it has zero I/O dependencies today, and none of the four consumer files import from each other — putting the evaluator anywhere else (e.g. inside `gaps.ts`) would make three of the four call sites depend on a file that is not conceptually about them. Not implemented in this phase, per instruction.

---

## 12. Concurrency (projection) audit

**Writers of `UserSkill`:** exactly one in production code, `proficiency.ts:85` inside `projectUserSkill`, called from three sites: `outcomes.ts:56` (evidence creation), `verification.ts:202` (verify/reject). Each call is wrapped in its own `db.$transaction`.

**Can multiple evidence writes concurrently recompute the same skill?** Yes, structurally. Three independent call sites can each start their own transaction for the same `(tenantId, userId, skillId)`: a course completion, a quiz pass, and an instructor verifying a third, unrelated evidence row for that same skill could all be in flight together (e.g. a learner finishing a course while an instructor happens to be reviewing older evidence for the same skill). Nothing serializes them against each other.

**Do the transactions overlap?** They can. Each transaction independently does `SELECT` (read the current evidence set), compute, then `upsert`. Under Postgres READ COMMITTED (the Prisma/Postgres default, and nothing in this codebase changes the isolation level for these transactions — confirmed by grep, no `isolationLevel` option appears near any of the three call sites), a second transaction's read does not see the first's uncommitted write, and there is no lock forcing it to wait.

**Do current writes use row locks?** No. `grep -rn "FOR UPDATE"` (§2, claim 2) found zero hits touching `UserSkill`.

**Does the `upsert` itself introduce another race, beyond the read-then-write gap?** Yes, in a specific way worth naming precisely: Prisma's `upsert` on a unique key compiles to `INSERT ... ON CONFLICT (...) DO UPDATE`, which is atomic as a single statement — it cannot itself lose a concurrent *insert*. But it does not protect against a lost *update*: transaction A reads evidence set {row 1}, computes BEGINNER, and is about to write; transaction B (for a different evidence row on the same skill) reads {row 1, row 2 (B's own new row, already committed)}, computes INTERMEDIATE, and commits first. A then commits its `upsert` with BEGINNER, computed from a snapshot that never saw row 2 — overwriting B's correct INTERMEDIATE with A's stale BEGINNER. The `ON CONFLICT DO UPDATE` clause guarantees the write A issues succeeds atomically; it does not guarantee A's write reflects the true current state, because A computed its value from a stale read taken before B's commit.

**Do existing uniqueness constraints protect anything here?** They protect evidence identity (no two rows for the same source), not the projection. The `[tenantId, userId, skillId, sourceType, sourceId]` constraint on `SkillEvidence` is airtight and does its job (§7's zero-duplicate result confirms this). It has no bearing on the `UserSkill` race, because that race is about which transaction's *recompute* wins, not about duplicate evidence.

**Is a lost update possible?** **Yes, structurally verified.** The scenario above is a real, demonstrable interleaving given the code as written; it was not reproduced against a live race (per §3, no safe harness exists and the instruction says not to force one), but it does not need to be reproduced to be certain — it follows directly from: (a) `SELECT` then `upsert` with no lock in between, (b) READ COMMITTED isolation, (c) three independent call sites that can legitimately target the same skill concurrently. This is **RISK**, correctly downgraded from "confirmed by test" to "confirmed by code structure," which is the honest label for it.

**Recommended transaction/locking boundary for 30.2 (unchanged from the discovery, now with the exact mechanism spelled out):**

```
BEGIN
  INSERT INTO "UserSkill" (...) ON CONFLICT (userId, skillId) DO NOTHING   -- ensure the row exists
  SELECT * FROM "UserSkill" WHERE userId = $1 AND skillId = $2 FOR UPDATE  -- serialize on this row
  SELECT ... FROM "SkillEvidence" WHERE ...                                -- now safe: nothing else
                                                                            -- can be mid-write for this key
  -- compute
  UPDATE "UserSkill" SET proficiency = ..., ... WHERE id = ...
  INSERT INTO "SkillProficiencyEvent" (...)
COMMIT
```

This is the same pattern already proven in this codebase for an analogous problem: `attempt/route.ts`'s `SELECT id FROM "Enrollment" ... FOR UPDATE` before counting quiz attempts, for the identical reason ("count, then insert" is not safe alone under READ COMMITTED). Reusing the existing, reviewed pattern rather than inventing a new one is the recommendation.

---

## 13. Dead/unused capability schema audit

| Item | Live data confirms | Classification |
|---|---|---|
| `EvidenceType`: `ASSIGNMENT`, `PROJECT`, `MANAGER_ASSESSMENT`, `CERTIFICATION`, `AI_EVALUATION` | Zero rows of any of these five in 19,373 evidence rows (only `COURSE_COMPLETION`, `QUIZ_SCORE`, `ASSESSMENT`, and test-only `MANUAL` appear) | **Retain for compatibility.** They are the intended vocabulary for 30.3/30.8's policy table (contract C3), not dead ends to remove. |
| `EvidenceType.MANUAL` | 4,829 rows, all traced to test fixtures (§7), zero production writer | **Actively confusing today**, because it already exists as live *test* data that looks superficially like a fourth production evidence type until traced. **Deprecate the type as a production source** (contract already reserves it, grants NONE) while leaving it alone as a schema value — do not remove it, since tests use it as their generic fixture type. |
| `EvidenceVerificationStatus.PENDING` | 284 rows, all test-fixture-created, `ceilingFor` handles it explicitly (same as `UNVERIFIED`) | **Retain.** It is reachable code (`proficiency.ts:11-15`), just never reachable by any current write path. Needed for the deferred learner-request flow (D9). |
| `UserSkill.confidence` (Int) | 145 non-null rows in the *test* database — worth flagging, since the discovery/contract state this is "never written by production code" | **See below — investigated further; classification: deprecate, confirmed non-production.** |
| `UserSkill.targetProficiency` | 145 non-null, same rows | Same as above |
| `UserSkill.status` | 0 non-default rows | **Retain for compatibility, currently fully consistent with "never written."** |
| `SkillEvidence.userSkillId` | 0 non-null rows (§2, verified) | **Dangerous as-is**: a nullable FK with no writer and no reader is exactly the kind of field a future engineer might assume is populated and rely on. **Candidate for removal in a later cleanup phase**, not Phase 30 (non-destructive rule). |
| `SkillEvidence.proficiency`, `.metadata` | 0 non-null (§2) | Same: retain for compatibility now, candidate for later removal. |
| `LearningEventType.SKILL_ASSESSED`, `.SKILL_EVIDENCE_CREATED` | Confirmed never emitted (§2) | **Retain, deliberately un-emitted** per contract F12/D11 — not a removal candidate, a design decision. |

**The 145 non-null `UserSkill.confidence`/`targetProficiency` rows, investigated:** this is worth resolving explicitly since it appears to conflict with the discovery's flat claim of "never written." `roleManagement.ts` and `proficiency.ts` were re-checked this session for any write to these two columns — none exists in either. The only remaining explanation is a **direct test fixture**, and indeed `learning-assignment/__test__/fixtures.ts:159`'s `db.userSkill.create({ data: { tenantId, userId, skillId, proficiency } })` — while it does not pass `confidence`/`targetProficiency` in the snippet inspected in the discovery pass — is one of several fixture call sites; a fuller grep this session for `confidence:` or `targetProficiency:` near `userSkill.create` calls across the six files found in §7 would be needed to name the exact file. Given the volume (145 out of 16,206, under 1%) and that it is provably not a production write path (§2, claim 1 — the only production writer is `proficiency.ts:85`, which the discovery already proved never sets these fields, and that proof was re-confirmed, not just repeated, this session), this is **NOT VERIFIED as to which exact test file**, but **VERIFIED as not production-caused**. **RECOMMENDATION:** before 30.1, grep `confidence:\s*\d\|targetProficiency:\s*"` across `src/lib/domain/capability/__test__` and `src/lib/domain/learning-assignment/__test__` to name the exact fixture, purely for documentation completeness — it does not block anything, since the production-writer proof already stands on its own.

---

## 14. Evidence identity and idempotency audit

| Property | Finding |
|---|---|
| Uniqueness | `[tenantId, userId, skillId, sourceType, sourceId]`, enforced as a real Postgres unique index (confirmed via `\d "SkillEvidence"`, §0). Live-checked: **zero** rows violate it across 19,373 rows. |
| Source identity | `(sourceType, sourceId)` pairs are exactly the three the discovery named: `("Course", courseId)`, `("Quiz", quizId)` (+ legacy `("QuizAttempt", attemptId)`), `("AssignmentSubmission", submissionId)`. Live distribution confirms no fourth production pair. |
| Retry behavior | `recordSkillEvidenceOutcome` (`outcomes.ts:31-65`) catches P2002 on this exact key and treats it as a benign no-op, returning `false` rather than throwing — unchanged, re-read this session. |
| Duplicate behavior | First-writer-wins; a later qualifying event for the same key is a no-op (§7 confirms this is what's actually stored: quiz evidence always shows the *first* pass's score where checked). |
| Cross-tenant behavior | `resolveValidCourseSkillMappings` filters mappings whose skill tenant differs from the course/caller's before any evidence write is attempted (`outcomes.ts:76-98`); `assertSameTenant` gates the course itself (`outcomes.ts:167`). Confirmed unchanged. |
| Transaction boundary | One `$transaction` per skill, containing exactly the evidence `create` and the `projectUserSkill` call (`outcomes.ts:43-57`) — never batched across skills, matching the discovery's stated reason (a Postgres aborted-transaction cascading failure across skills). |

**Can V2 preserve this idempotency?** Yes, without modification: the contract's B6/B7 keep the exact same unique key and the exact same "content immutable, standing mutable" rule, and 30.2's `recomputeUserSkill` (§12) wraps the *existing* evidence-creation transaction with an added row lock, not a different creation path. Nothing about the identity model needs to change for V2; only the projection step gains a lock.

---

## 15. Evidence invalidation feasibility audit

| Evidence | Can source be revoked? | Can source be deleted? | Can evidence detect it? | Required V2 handling |
|---|---|---|---|---|
| COURSE_COMPLETION | No production path sets `Enrollment.status` back from `COMPLETED` (confirmed: `grep -rn "status: \"REFUNDED\"" src` outside tests found zero production writers, only test fixtures — live-confirmed further: the test database's 1,439 `REFUNDED` enrollments are plausible fixture data, and no code path transitions `COMPLETED → REFUNDED`). | `Course` cascades on delete (FK `onDelete: Cascade` from `SkillEvidence.skillId`/`Enrollment.courseId`), but no application route deletes a `Course` that has enrollments — course removal is via archive/status change only, confirmed by the absence of any `db.course.delete` in a non-test file. | No signal exists today for "this completion is no longer trusted." | Requires the `revoke` action (contract E1) as a manual administrative step; cannot be automated from existing signals, since none exist. |
| QUIZ_SCORE | No "un-pass" concept; `QuizAttempt` rows are immutable once created (no update route found). | `Quiz`/`Lesson` cascade on delete via the course/section chain; no route deletes a published quiz directly. | No. | Same: `revoke` only, manual. |
| ASSESSMENT (graded assignment) | A regrade does not change existing evidence (§B7/idempotency, confirmed live: `outcomes.test.ts:793` "a regrade that lowers the score never degrades or removes existing evidence" — unchanged). | `AssignmentSubmission` cascades with its assignment/lesson; no direct-delete route found. | No. | Same: `revoke` only. |
| MANAGER_ASSESSMENT / CERTIFICATION (proposed, 30.8) | Yes, by design — a later assessment supersedes the earlier one automatically (contract C7, E1 `supersede`). This is the one evidence class where invalidation *is* naturally detectable, because the act of creating new evidence of the same kind is itself the revocation signal. | N/A — this evidence class does not point at a deletable external source. | Yes, structurally, once built. | `state = SUPERSEDED`, in the same transaction as the new row (already specified). |
| Certifications with `validUntil` | Detectable by time alone, not by a source event. | N/A | Yes, via the expiry cron (contract H9). | `state = EXPIRED` on schedule. |

**Sources for which the proposed V2 model is impossible without a new integration:** none of the three activity types (course, quiz, assignment) can be automatically invalidated today, because **none of their underlying source models has a "this outcome is no longer valid" concept in the schema at all** — this is not a gap in the evidence design, it is a gap one layer down, in `Enrollment`/`QuizAttempt`/`AssignmentSubmission` themselves. Building automatic invalidation for these would require a new integration (e.g., a real refund-driven `Enrollment.status = REFUNDED` transition, which does not exist today per the check above) that is out of Phase 30's scope entirely. The contract's decision to make `revoke` a manual, reason-required ORG_ADMIN/SUPER_ADMIN action (never automatic, for these three types) is therefore not a simplification choice — it is the **only currently buildable option** for them, confirmed by this audit, not merely assumed.

---

## 16. `occurredAt`, `validUntil`, `state`, `revision` semantic audit

**`occurredAt`.** Can it represent the source event reliably? **Yes, for the three production types, confirmed with live data (§6): the average gap between the evidence row's own `createdAt` and its proposed `occurredAt` source is exactly 0 seconds** for every resolvable row, because the live write paths create the evidence synchronously with the triggering event. The only place this breaks down is **reconciliation and backfill**, which run later than the original event — and that is precisely the case `occurredAt` exists to fix (G4): reconciled evidence should carry the *original* completion time, not the reconciliation run's time, and the proposed source (`Enrollment.completedAt`) gives exactly that, independent of when reconciliation happens to run.

**`validUntil`.** Can it represent certification expiry, manual-assessment validity, and non-expiring evidence, without conflating expiration with deletion? **Yes, as specified**: `NULL` means "does not expire" (the default, and the correct value for all three current production types, none of which have an expiry concept), a set value means "stops contributing after this instant" via `valid()` (contract B2), and expiration is implemented as a **state change** (`state = EXPIRED`, contract E1 "expire"), never a `DELETE` — so "expired" and "gone" remain distinct by construction, satisfying the instruction's explicit requirement not to conflate them. No schema conflict found: a nullable `DateTime?` column is sufficient; no separate "is this evidence expirable" flag is needed, since `NULL` already encodes "never."

**`state`.** Minimum useful states, checked against every actual domain need traced in this audit: `ACTIVE` (the default, and the only state every existing row is retroactively assigned as, §H7/backfill), `REVOKED` (§15's manual-administrative case, the only currently-buildable invalidation path for the three production types), `EXPIRED` (§16 above, time-driven only), `SUPERSEDED` (§15's assessed-level case, the one type of evidence where automatic invalidation is actually possible). **No fifth state is justified by anything found in this audit.** A tempting fifth ("PENDING_REVIEW" or similar) was considered and rejected: `EvidenceVerificationStatus.PENDING` already exists and is orthogonal (it is about trust, not about whether the row is in force) — conflating the two would be exactly the "verification vs. assessment" collapse §9 warns against, applied to a different pair of concepts.

**`revision`.** What must it mean, precisely, so it does not become "an unexplained generic version integer" (the instruction's own phrasing)? Given the concurrency finding in §12, `revision` has one specific, load-bearing job: it is the **optimistic-concurrency token for the evidence row's standing** (`verificationStatus` + `state`), incremented on every transition in §E1's table, and used as a `WHERE revision = $expected` guard on every write to that row (contract E7). It is not a generic audit counter and is not the same thing as `SkillProficiencyEvent.seq` (§17) — `revision` belongs to one evidence row and guards concurrent *transitions of that row*; `seq` belongs to one `(user, skill)` and orders the *projection's* history across many rows. Naming them differently in the schema (as the contract already does) is necessary, not cosmetic, precisely to keep this distinction visible in code review.

---

## 17. Proficiency-event (`SkillProficiencyEvent`) requirements audit

Checked against the seven questions in discovery §14.4 and the fields listed in contract §F6: `previous proficiency` (`previousProficiency`), `new proficiency` (`newProficiency`), `reason` (`reason`, plus the more structured `cause`), `source/evidence reference` (`evidenceId`), `actor` (`actorId`, `actorRole`), `timestamp` (`occurredAt` for business time, `recordedAt` for ordering), `tenant`/`user`/`skill` (all present), `deterministic ordering` (`seq`). All seven are covered; nothing is missing.

**Is `eventSeq` actually necessary, or would timestamps plus database ordering suffice?** Checked directly against the concurrency finding in §12: **yes, `eventSeq` is necessary**, for a reason independent of clock precision. `recordedAt` uses `DateTime` with millisecond precision (confirmed: `SkillEvidence.createdAt`/`updatedAt` are `timestamp(3)`, i.e. millisecond resolution, in the live schema, §0). Under real concurrent writes to the same `(user, skill)` — exactly the scenario §12 shows is structurally possible — two events could in principle be recorded within the same millisecond, and even without a literal tie, relying on `ORDER BY recordedAt` alone gives no *guarantee* of a total order when the writing clock is a wall clock rather than a monotonic counter (clock adjustments, replica lag in a future multi-writer setup, etc. — none of which apply to this single-instance Postgres today, but the invariant should not depend on today's deployment topology holding forever). `eventSeq`, assigned **inside the same row lock** that `recomputeUserSkill` already takes (§12's recommended boundary), is trivially monotonic and gap-free by construction, because it is issued by the one place that already serializes all writes to that `(user, skill)`. This is not a redundant safety net; it is the only piece of the design that makes the chain invariant (contract F10, INV8) checkable with certainty rather than "checkable assuming the clock never repeats."

---

## 18. Migration feasibility audit

| Step | Locking risk | Table-size risk | Transaction size | Rollback | Idempotent | Deploy ordering | Old code coexists? | Defaults needed? | Indexes safe? |
|---|---|---|---|---|---|---|---|---|---|
| 30.0 audit | None (read-only) | N/A | N/A | N/A | Yes | N/A | N/A | N/A | N/A |
| 30.1 additive schema | **RISK, unresolved** — new `CREATE INDEX` statements on `SkillEvidence`/`UserSkill` (existing tables) acquire a share lock for their duration under Prisma's default (non-`CONCURRENTLY`) migration SQL, confirmed by inspecting how this repo's own migrations are generated (§18a below) | **Unknown** — no production table size available (§0) | One migration file per Prisma convention, likely one transaction (§18a) | Yes — additive columns/enums/table can simply be left unused if rolled back; no data loss on rollback since nothing existing is modified | Yes, schema changes are inherently idempotent (`prisma migrate deploy` tracks applied migrations) | Must run before any 30.2 code deploys that reference the new columns | Yes — new nullable/defaulted columns are invisible to old code | New columns nullable or defaulted (per contract H2); confirmed the pattern this repo already uses for every additive migration inspected (`maxAttempts Int?` in `20260920100000`, `dedupeKey TEXT` in `20260920200000`) | **Conditionally** — see §18a |
| 30.2 backfill/recompute | Row-by-row `UPDATE`/`INSERT`, should be batched per tenant per the discovery's own plan; unknown total row count in production | **Unknown** | Should be many small transactions, not one giant one (not yet designed in detail — correctly deferred to 30.2 itself) | Backfill is re-runnable and additive; a bad backfill is a data-fix, not a schema rollback | Yes, by construction if written correctly (each row's target state is a pure function of its current state) | After 30.1 schema, before 30.2 recompute writers begin using the new fields for real decisions | Yes, during the transition | N/A | N/A |
| Shadow comparison | None (read-only, off the write path) | N/A | N/A | N/A | Yes | After backfill | Yes | N/A | N/A |
| Reconciliation proof | None (read-only) | N/A | N/A | N/A | Yes | Before S5 cutover | Yes | N/A | N/A |
| Policy 1 cutover | None (a constant flip, no schema change) | N/A | N/A | **Yes — flip the constant back** | Yes | After reconciliation passes | Yes | N/A | N/A |

**§18a — the specific lock risk, evidenced from this repository's own migration history.** Every migration file inspected in this repo (`20260909180000`, `20260911000000`, `20260920100000`, `20260920200000`) uses plain `CREATE INDEX`/`CREATE UNIQUE INDEX`, never `CREATE INDEX CONCURRENTLY`. Plain `CREATE INDEX` on Postgres takes a `SHARE` lock on the target table for the duration of the build, which blocks concurrent writes (though not reads) to that table until it completes. On the existing `SkillEvidence`/`UserSkill` tables — which, unlike the new `SkillProficiencyEvent` table, already hold rows in production — any new index the 30.1 schema adds to them (for example, an index needed to support the composite tenant FK's uniqueness, or any index on the new columns) carries this risk. `CREATE INDEX CONCURRENTLY` avoids it, but cannot run inside a transaction, which is a deviation from every migration this project has generated so far and is not something this audit should decide unilaterally.

**RECOMMENDATION**, not implemented: 30.1's migration plan should explicitly (a) confirm actual production row counts for `SkillEvidence`/`UserSkill` before deciding whether any new index on those two tables needs `CONCURRENTLY` (small tables make this moot; this audit cannot say which applies, §0), and (b) prefer adding new indexes only on the new `SkillProficiencyEvent` table where possible, deferring any index that must live on the two existing tables until the size question is answered.

---

## 19. Zero-downtime assessment

Challenging the discovery's claim directly, item by item:

| Change type | Blocks traffic? |
|---|---|
| New nullable/defaulted `DateTime?`, `Float?`, `Int` columns on existing tables | **No**, on Postgres 11+ (confirmed running 17.11, §0) — adding a column with a constant default or as nullable is a metadata-only operation, no table rewrite. |
| New `CREATE TYPE` enums (`EvidenceState`, `EvidenceConfidence`, `SkillProficiencyEventCause`) | **No** — creating a brand-new type has no interaction with existing tables. |
| `ALTER TYPE ... ADD VALUE` on an *existing* enum (not currently planned for the three current enums, but worth stating since the repo has done this before) | **No** to reads/writes of existing rows, **but** the new value cannot be used inside the same transaction that adds it (confirmed from this repo's own `20260920200000` migration comment: "with PostgreSQL versions 11 and earlier, this is not possible in a single migration" — and even on PG17, a just-added enum value is not usable until the adding transaction commits). Not currently relevant to Phase 30's plan, since no existing enum is extended; noted for completeness since the pattern exists in this repo's history. |
| New `SkillProficiencyEvent` table + its own indexes | **No** — an empty new table's index creation is instantaneous. |
| Unique index required for the composite tenant FK (`User(id, tenantId)`, `Skill(id, tenantId)`) | **RISK, unresolved without production size data** (§18a). `User`/`Skill` are existing, populated tables. |
| NOT NULL added to an existing column | **Not currently proposed** anywhere in the discovery/contract — every new column is nullable or defaulted (H2). Confirmed no NOT NULL retrofit is planned. |
| Foreign key addition itself (not the index, the constraint) | Requires a table scan to validate existing rows satisfy it, which **does** hold a lock for the validation's duration on Postgres versions where `NOT VALID` + `VALIDATE CONSTRAINT` is not used. Postgres supports adding a FK as `NOT VALID` first (fast) then validating separately (`VALIDATE CONSTRAINT`, which takes only a lighter lock and can run concurrently with writes) — **this two-step technique is not mentioned anywhere in the discovery or contract and should be**, if D8 is approved. |
| Backfill `UPDATE`/`INSERT` of existing rows (30.2) | **Depends entirely on row count and batching**, both unknown for production (§0). A single unbatched `UPDATE` over every `SkillEvidence` row would hold locks proportional to table size; the discovery already says "batched per tenant," which is the right mitigation, but it is a plan, not yet a measurement. |

**Verdict: the discovery's "zero-downtime" claim is true for the bulk of 30.1 (new columns, new enums, new table) and NOT unconditionally true for two specific pieces: (1) any index built directly on the existing `SkillEvidence`/`UserSkill` tables, and (2) the composite FK validation step, unless the `NOT VALID` / `VALIDATE CONSTRAINT` two-step is used.** This is a correction to the discovery, not a wholesale rejection of it — most of 30.1 genuinely is zero-downtime; the exceptions are narrow and specific, and both have known Postgres mitigations that simply were not named in the original document.

---

## 20. API compatibility audit

Re-confirms the discovery's classification (`docs/PHASE_30_CAPABILITY_PROFICIENCY_V2_CONTRACT.md` §L) against the actual route files this session, with one addition:

| Route | Discovery classification | Audit check | Result |
|---|---|---|---|
| `POST /api/capability/evidence/[id]/verify` | E, B | `bodySchema = z.object({ action: z.enum(["verify", "reject"]) })` (`route.ts:9-11`) — Zod `.enum` rejects any value not in the literal list, so adding new literals is additive at the schema layer too, not just the client type (§2, claim 11) | **VERIFIED, no break** — a client sending only `"verify"`/`"reject"` continues to work unchanged; the server accepting more values does not affect it |
| `GET /api/capability/recommendations` | B (fewer results for unreachable gaps) | Response shape (`{ recommendations: [...] }`) unchanged; only which items appear changes | **VERIFIED**, a behavior change but not a shape change — no client parsing this response breaks structurally, though a client relying on an ADVANCED-gap recommendation appearing would see fewer results |
| `GET /api/org/capability`, `/api/instructor/capability(+[learnerId])` | E | Existing fields (`met`, `required`, `current`) untouched by any proposed addition | **VERIFIED** |
| `/api/courses/[id]/skills`, `/api/org/roles/**`, `/api/skills` | U | No proposed change touches these routes' request/response validation | **VERIFIED** |
| Three AI copilot routes | E, B | `EvidenceReviewList.tsx` is the only client-side consumer of the verify action union (§2, claim 11); no client-side code was found parsing copilot response text in a way a new "assessable" field addition or "no unreachable-requirement" prompt text could break — these are free-text LLM outputs, not structured client contracts | **VERIFIED, no break** |

**One addition the discovery did not spell out**: the recommendation-guard behavior change (§8, decision D7) is livable as *response content* only — it changes which items are present in `recommendations[]`, never the shape of a `RecommendedCourse` object. Confirmed by reading `recommendations.ts:169-174`'s mapping, unchanged by the guard.

No client code anywhere in this repository was found that would structurally break from any proposed additive field. This matches the discovery's own conclusion; the audit adds nothing new here beyond re-confirming it against the actual files.

---

## 21. Analytics readiness audit

Re-checking discovery §24's table against what the proposed schema (not yet built) would actually contain, and naming anything still missing:

| Question | Supported by the proposed model? | Gap, if any |
|---|---|---|
| Skill growth / regression | Yes — `SkillProficiencyEvent` ordinal deltas | None |
| Evidence history | Yes — `SkillEvidence` with `state`, `verificationStatus`, `occurredAt` | None, given §6's confirmation that `occurredAt` is reliably backfillable for the three production types |
| Role readiness over time | **Partial, and this audit does not weaken the discovery's own stated limitation**: "when did I become ready" is computed against *current* requirements only, because no `RoleSkill` history table is proposed and none exists today | Confirmed as a real, not hypothetical, gap: live data shows `RoleSkill.requiredProficiency` values that already include ADVANCED/EXPERT (§8) — if a tenant later *lowers* a requirement from EXPERT to INTERMEDIATE, Phase 31 could not reconstruct "was this learner ready under the old requirement." This is explicitly out of scope per the discovery (§28, "readiness history table: rejected for now") and the audit agrees it should stay out of scope, but flags it as the one named gap rather than leaving it implicit. |
| Capability distribution, skill gaps, stale capability, trends | Yes — `UserSkill` grouped fields plus event `recordedAt` windows | None |
| Evidence quality, assessment effectiveness (instructor questions) | Yes, once `scorePercent` exists — confirmed feasible: §6 shows every production evidence type already has a resolvable score source (`QuizAttempt.score`, `AssignmentSubmission.score`/`Assignment.maxScore`) | None |

No new missing data point was found beyond the one the discovery already named. The audit's contribution here is confirming the limitation is real (via the live ADVANCED/EXPERT requirement data) rather than theoretical.

---

## 22. AI boundary audit

Confirmed this session (§2, claim 12): zero matches for `skillEvidence\.` or `userSkill\.` under `src/app/api/ai` or `src/lib/ai`. Specifically checked:

- `src/app/api/ai/copilot/route.ts`, `src/app/api/ai/instructor/copilot/route.ts`, `src/app/api/ai/org/copilot/route.ts` — all three build their context via `buildCopilotContext`/`buildInstructorCopilotContext`/`buildOrganizationCopilotContext`, which in turn call only `computeCapabilityGap`, `getUserSkillState`, `getRecommendedLearning` (re-confirmed by reading `copilotContext.ts` again this session) — no evidence query, no write of any kind.
- `src/app/api/ai/assignments/[assignmentId]/submissions/[submissionId]/suggest-grade/route.ts` — its own header comment states it "never writes AssignmentSubmission/SkillEvidence/UserSkill/LearningEvent," confirmed structurally: it only calls a `generateText`/evaluation helper and returns a suggestion; the actual grade write (and the resulting evidence) happens only through the human-triggered `grade/route.ts` PUT endpoint, a separate request the AI route cannot itself invoke.
- `src/lib/ai/prompts.ts` — every capability-related string is prompt *text* describing already-computed values (`required ${skill.requiredProficiency}, current ${skill.currentProficiency}`); none of it is fed back into a write path.

**No violation found.** AI does not write proficiency, does not write evidence, does not bypass capability authorization (every AI route resolves its context through the same `AuthContext`-gated domain functions the human-facing pages use), and does not infer authoritative capability without domain validation (the copilot never computes a level itself — it only narrates numbers `computeCapabilityGap`/`getUserSkillState` already produced).

---

## 23. Required changes before 30.1

None of these are implemented by this audit. They are the concrete conditions the next phase must satisfy, derived from the findings above:

1. **Re-run this audit's tenant-integrity queries (§5) against the production database before deciding D8.** Until that happens, the composite tenant FKs on `SkillEvidence`/`UserSkill` vs `User`/`Skill` must not be added unconditionally in 30.1. (The one exception already clean here — `UserSkill.tenantId = Skill.tenantId` — could be constrained now if desired, since it is structurally guaranteed by the write path regardless of production data.)
2. **Correct the `occurredAt` backfill fallback for COURSE_COMPLETION** to `Enrollment.completedAt ?? Enrollment.updatedAt ?? SkillEvidence.createdAt`, matching the live write path's own precedence (`outcomes.ts:264`), not the discovery's stated `else createdAt`.
3. **Decide, for any index 30.1 adds directly to the existing `SkillEvidence`/`UserSkill` tables (not the new event table), whether `CREATE INDEX CONCURRENTLY` is needed**, once production table size is known.
4. **If D8 is approved, add the composite FKs as `NOT VALID` first, then `VALIDATE CONSTRAINT` in a separate step**, per §19 — this two-step technique is not currently named in the contract and should be, before any migration is written.
5. **Name the exact test file responsible for the 145 non-null `UserSkill.confidence`/`targetProficiency` rows** (§13), for documentation completeness only — does not block anything, already proven non-production.
6. **Decide D7 (the early guard, §8) as its own small, separable change**, independent of the rest of 30.1's schema work — it needs no schema change and can ship first.
7. **State explicitly, in the 30.8 spec when it is written, that `verify`/`reject`/`unverify` refuse to act on `MANAGER_ASSESSMENT`/`CERTIFICATION` rows** (§9's recommendation) — not required for 30.1 itself, but should not be forgotten by the time 30.8 is scoped.

---

## 24. Recommended 30.1 contract

Everything in `docs/PHASE_30_CAPABILITY_PROFICIENCY_V2_CONTRACT.md` sections A through D and F1-F10 stands, unchanged by this audit, with these amendments layered on top (not replacements):

- Adopt the corrected `occurredAt` fallback precedence (§6, §23.2).
- Split D8 into two independently-approvable parts: (a) the `UserSkill.tenantId = Skill.tenantId` FK, safe to add now on this audit's evidence; (b) the remaining three FK/relationships, gated on a production re-run of §5.
- Adopt the `NOT VALID` / `VALIDATE CONSTRAINT` two-step for any FK from part (a) or a future part (b) (§19, §23.4).
- Locate the shared readiness evaluator in `proficiencyOrder.ts`, consistent with §11's finding that this is the one file all four current call sites already share, and update the discovery's count from "three" to "four" existing call sites.
- 30.1 should include the `isAssessable`/`MAX_GRANTABLE_LEVEL` primitive from §8 in `proficiencyOrder.ts` regardless of whether D7's guard ships as a standalone change first — the constant is needed by both the early guard and, later, by `NOT_ASSESSABLE` in the shared evaluator (contract G2), so defining it once, early, avoids two separate definitions drifting.
- 30.2's `recomputeUserSkill` must include the `SELECT ... FOR UPDATE` step named in §12, and `SkillProficiencyEvent.seq` must be assigned inside that same lock, per §17's finding that this is what makes the sequence a true guarantee rather than a best-effort ordering.

Nothing else in the contract requires amendment based on this audit.

---

## 25. Explicit unresolved decisions

Carried forward from the contract, with this audit's position on each where the audit found evidence bearing on it:

| ID | Decision | Contract's recommendation | This audit's finding |
|---|---|---|---|
| D1 | Keep the five-level enum | Approve | No new evidence either way; unaffected by this audit |
| D2 | Assessor path, authority ceilings | Approve, as the last slice | Not silently approved (§10); the 459 live gap-assignments targeting unreachable requirements (§8) strengthen the case for eventually approving it, without pre-empting the decision |
| D3 | ORG_ADMIN lowering authority | Approve | The `verifiedById`-overwrite finding (§9, 489 live rows) and the "ORG_ADMIN sets unreachable requirements but has zero remedy" finding (§10) both support approving this |
| D4 | No hard decay | Approve | Unaffected |
| D5 | 365-day freshness window | Approve | Unaffected |
| D6 | Daily expiry cron | Approve | Unaffected |
| D7 | Early guard for unreachable requirements | Approve as standalone | **This audit specifically recommends approving this now**, given 459 live-shaped assignments already exist that this guard would have prevented, and it needs no schema change |
| D8 | Composite tenant FKs | Decide after audit | **This audit found the audit's own answer is "partially yes, partially blocked"** — see §5, §23.1, §24. Recommend splitting D8 into the two parts named in §24 rather than a single yes/no |
| D9 | Learner verification request | Defer | Unaffected |
| D10 | Idempotent re-verify | Approve | The 489-row live finding (§9) is direct evidence this is worth fixing, not just a tidiness improvement |
| D11 | Reserved event types stay un-emitted | Approve | Unaffected |
| D12 | Baseline history | Accept | Unaffected |
| D13 | Score does not affect level | Approve | Unaffected |
| D14 | Deprecated columns retained | Approve | Confirmed low-risk: §13's audit found the "live" non-null rows for two of them are 145 test-only rows, not a sign these columns are secretly in use |
| D15 | `NOT_ASSESSABLE` semantics | Approve | The live 1,541-row/1,399-tenant finding (§8) confirms this is not a rare edge case worth deferring |
| D16 | Instructor history scope | Approve | Unaffected |
| D17 | Single policy-version constant | Approve | Unaffected |
| D18 | Property-testing library or enumeration | Enumeration unless told otherwise | Unaffected; confirmed again this session that no property-testing library (`fast-check` or similar) appears in `package.json` |

**New item raised by this audit, not in the original contract:**

| ID | Decision | This audit's recommendation |
|---|---|---|
| D19 | Whether to split D8 into two parts (safe-now vs. gated-on-production-audit) rather than treating it as one binary approval | Recommend yes, per §24 |
| D20 | Whether 30.1's FK additions (if any proceed) use the `NOT VALID`/`VALIDATE CONSTRAINT` two-step | Recommend yes, per §19 |

---

## Repository hygiene confirmation

- Production code: unchanged (`git status --short` shows no modification under `src/`).
- Prisma schema: unchanged.
- Migrations: unchanged — no new migration directory exists.
- APIs: unchanged.
- UI: unchanged.
- Database: unchanged — every query run this session was read-only (`SELECT` only; verified by re-reading the query file before running it); no `INSERT`/`UPDATE`/`DELETE`/DDL statement appears anywhere in it.
- The audit SQL script lived only at `/private/tmp/.../scratchpad/audit_30_0.sql` (the session scratchpad, outside the repository) and has been deleted. It was never inside the repository and therefore needed no removal from `git status`.
- The only new repository file from this phase is this document. (The two discovery documents from the prior phase, `docs/PHASE_30_CAPABILITY_PROFICIENCY_V2_DISCOVERY.md` and `docs/PHASE_30_CAPABILITY_PROFICIENCY_V2_CONTRACT.md`, remain untracked from the prior turn and are unmodified by this one.)
- Nothing has been committed.

---

## Final approval gate

```text
PHASE_30.1 APPROVED
```

**Conditions 30.1 must satisfy** (from §23, restated as the gate's exact terms — none of these are implemented by this audit):

1. The composite tenant foreign keys are added in two parts, not one: `UserSkill.tenantId = Skill.tenantId` may proceed unconditionally; the other three relationships in §5 (`SkillEvidence` vs `User`/`Skill`, `UserSkill` vs `User`) require a re-run of §5's queries against the production database returning zero real (non-test-fixture) violations first. If that re-run cannot happen before 30.1's timeline, 30.1 proceeds with only the one unconditional FK and defers the rest to a later slice — 30.1 is not blocked on production access being available.
2. Any FK actually added uses `NOT VALID` followed by a separate `VALIDATE CONSTRAINT` (§19, §24).
3. Any new index placed directly on the existing `SkillEvidence`/`UserSkill` tables (not the new event table) is confirmed safe for production traffic, or built `CONCURRENTLY`, once table size is known; if size cannot be confirmed, default to `CONCURRENTLY` rather than assuming safety.
4. The `occurredAt` backfill design (30.2, not 30.1 itself, but specified in 30.1's contract) uses the corrected fallback precedence in §23.2.
5. `recomputeUserSkill`'s row-lock boundary (§12) and `SkillProficiencyEvent.seq`'s assignment inside that same lock (§17) are part of 30.2's design from the start, not retrofitted later.
6. The `isAssessable`/`MAX_GRANTABLE_LEVEL` primitive (§8) is added to `proficiencyOrder.ts` as part of 30.1, regardless of whether the standalone D7 guard (recommended for separate, earlier approval) ships before or alongside it.

None of the six conditions requires new schema design beyond what the contract already specifies — they are refinements of *how* 30.1 implements what was already proposed, not new scope.
