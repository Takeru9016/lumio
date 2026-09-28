# Phase 30.4 — Capability History Read Surface: Implementation Report

Builds on `docs/PHASE_30.4_DISCOVERY.md` (`PHASE_30.4 IMPLEMENTATION APPROVED`), which this report treats as the authoritative contract — every design decision below traces to a specific discovery section, and no behavior was invented beyond what the discovery already resolved.

**This report's own numbering runs to 20 sections against the task's 18-item list** (§28), because two sections earned their own slot rather than being folded into a neighbor: **§9 Date semantics** (the task's own §16 asks for exact boundary/inclusivity/parsing rules, detailed enough to warrant separation from §7 Pagination) and **§19 Final validation** (the task's own §29 "full validation" requirements — test suite, tsc, prisma, build, diff check — reported as one table rather than scattered across other sections). This mirrors Phase 30.3's own precedent of inserting a numbered section where the task's flat list under-specified the report's own internal structure, disclosed once here rather than left for a reader to reconcile silently.

**A real defect was found and fixed during this report's own review pass, after an initial implementation and an initial version of this report both claimed completion.** It is disclosed in full in §13 (the mutation round that found it) and §18 (as a known-risk-class item) rather than smoothed over — the discovery's own established practice in this session, carried forward here.

---

## 1. Implemented scope

Exactly the approved scope, nothing beyond it:

1. Domain read models (`src/lib/domain/capability/history.ts`) — `ProficiencyHistoryItem`, `EvidenceStandingHistoryItem`, a discriminated `HistoryItem` union.
2. Learner-self history: `getLearnerHistory` + `GET /api/capability/history`.
3. Instructor-owned-evidence history: `getInstructorLearnerHistory` + `GET /api/instructor/capability/[learnerId]/history`.
4. ORG_ADMIN tenant-wide history: `getOrgLearnerHistory` + `GET /api/org/capability/[learnerId]/history`.
5. Cursor pagination — three ordering modes (`seq`, `revision`, `recorded`), matching discovery §12/§13.
6. Filtering — `skillId`, `type`, `from`/`to` (all three routes), `evidenceId` (instructor/org only, discovery §14) — applied in **every** ordering mode, not only when it happens to select `revision` mode (§13's own disclosed correction).
7. Privacy-safe response contracts — the field-exposure table and `reason`/`actorName` allowlists from discovery §5/§6, enforced in the mapper, not left to callers.
8. Authorization and tenant isolation — discovery §7/§8/§9/§21/§22, reusing existing locked patterns (`instructorReport.ts`'s enrollment-ownership predicate, `deletedAt: null` per contract E6).
9. Performance/N+1 protection — batched source-context and skill-name resolution (discovery §20), never one query per row.

**Not implemented, matching the task's explicit exclusions**: no schema change, no migration, no capability recalculation, no confidence changes, no evidence mutation, no verification changes, no UI, no AI-specific history API, no analytics, no assessor functionality, no production D24 remediation. Confirmed by the diff itself (§16) — every changed/added file is additive, and `git diff --stat` against every tracked file matches Phase 30.3's own baseline exactly, unchanged by this phase.

---

## 2. Domain read models

`src/lib/domain/capability/history.ts`, one module, three public entry points sharing internal query/mapping machinery. Types:

```ts
type HistoryItem =
  | ({ type: "PROFICIENCY_CHANGED" } & ProficiencyHistoryItem-shaped fields)
  | ({ type: "EVIDENCE_STANDING_CHANGED" } & EvidenceStandingHistoryItem-shaped fields)
```

matching discovery §18's discriminated-union decision exactly. Neither item type is ever flattened into a generic "event" shape — each retains every field discovery §4/§5 specified, and no more.

**Ordering mode** (discovery §12) is a pure function, `determineOrderingMode(filters)`, tested in isolation with no database (`determineOrderingMode` describe block, 6 tests):

- `type=PROFICIENCY_CHANGED` + `skillId` → `seq` mode (lock-serialized, proven-stable — `SkillProficiencyEvent.seq`).
- `type=EVIDENCE_STANDING_CHANGED` + `evidenceId` → `revision` mode (`EvidenceStandingEvent.evidenceRevision`).
- Every other combination → `recorded` mode (`(recordedAt, id)` keyset), single-table or merged depending on whether `type` narrows to one event type.

This is the concrete implementation of discovery §12's correction: `seq`/`evidenceRevision` are used exactly where they have a construction-level proof (a `FOR UPDATE` lock held until commit serializes concurrent writers), and `recordedAt` is used everywhere else, matching the established, already-accepted risk `adminAssignments.ts`'s own cursor already carries on the identical `@default(now())` column type.

---

## 3. Endpoint inventory

| Route | Scope | Role gate | Discovery § |
|---|---|---|---|
| `GET /api/capability/history` | Learner, self only | any authenticated user with a tenant (no role restriction — matches `/capability`'s own existing no-gate posture) | §4, §16 |
| `GET /api/instructor/capability/[learnerId]/history` | Instructor, owned-evidence scope | `INSTRUCTOR` | §7, §16 |
| `GET /api/org/capability/[learnerId]/history` | ORG_ADMIN, tenant-wide | `ORG_ADMIN` (SUPER_ADMIN excluded, no exception) | §8, §9, §16 |

All three follow the existing `requireAuthContext` → `requireTenant` → (`requireRole` where applicable) → validate query → call domain function → map errors chain every other route in this domain already uses (`org/capability/route.ts` was the direct template). The org route shape (discovery §16: `[learnerId]` path segment recommended over a `?userId=` query filter, since org's own existing top-level route had no precedent either way) was built here as a path segment, matching the instructor route's own existing `/[learnerId]` precedent — the recommendation discovery §16 itself stated, adopted rather than left open.

---

## 4. Authorization model

**Learner**: self-scoped by construction (discovery §4) — `getLearnerHistory(ctx, filters, opts)` takes no `userId` parameter at all. There is no field to forge, not merely a runtime check that could be bypassed.

**Instructor** (discovery §7, the section this phase most directly implements): two sequential gates, both copied from the exact existing predicate shapes rather than invented —
1. `db.enrollment.findFirst({ where: { userId: learnerId, course: { instructorId: ctx.userId, tenantId: ctx.tenantId } } })` — identical shape to `getInstructorLearnerRoles`'s own ownership check (`instructorReport.ts:300-304`).
2. `db.user.findFirst({ where: { id: learnerId, tenantId: ctx.tenantId, deletedAt: null } })` — identical shape to `getInstructorCapabilityForLearnerRole`'s own soft-delete exclusion (`instructorReport.ts:341-343`).

Either gate failing returns `null`, mapped to the same 404 by the route, never a distinguishable status.

**Authorized-evidence-id resolution** (the actual novel work of this phase): every `SkillEvidence` row for the learner is fetched once, its source batch-resolved (§11 below), and filtered to `resolved.instructorId === ctx.userId`. That id set is threaded into **every** underlying event query's own `WHERE evidenceId IN (...)` clause — both `SkillProficiencyEvent` and `EvidenceStandingEvent` — never applied as a post-fetch filter. This is the direct implementation of discovery §7's corrected design (the "filter before cut, not after" fix that same discovery pass found necessary in its own first draft).

**ORG_ADMIN** (discovery §8): one gate — the same `deletedAt: null` tenant-scoped learner check, no course-ownership narrowing. `SUPER_ADMIN` is excluded by the role gate with no special-casing anywhere (discovery §9's corrected "none, full stop" decision).

---

## 5. Tenant isolation

Every query bakes `tenantId` into its own `WHERE` clause — confirmed not merely by design but by a dedicated **defense-in-depth test class**: a request with a genuine `userId`/`instructorId` but a *deliberately wrong* `ctx.tenantId` (simulating a compromised or buggy caller) must still return nothing. This is a real, non-trivial guarantee in a schema where `User.id` and `Course.instructorId` are globally unique cuids — omitting the tenant predicate would be invisible in every "normal" test built from a genuine `AuthContext` (tenantId and userId are always mutually consistent there), which is exactly why the mutation pass caught it and the discovery/task's own "never trust ownership alone to imply tenant scope" convention exists. One test goes further still, isolating the enrollment-ownership predicate specifically from the separate learner-existence check (which shares the same `ctx.tenantId` and could otherwise mask the enrollment check's own contribution): a malformed `Enrollment` linking a real learner in tenant B to a real course in tenant A, with `ctx.tenantId` spoofed to B (so the learner-existence check alone would pass) — the enrollment predicate's own `tenantId` clause is what remains the only thing standing between authorized and not.

Cross-tenant `learnerId` on the instructor/org routes returns the same 404 as a nonexistent one — no distinguishable 403, matching the D23 fix from Phase 30.3 (`verification.ts`) and re-applied here as this phase's own instance of the same rule (discovery §21).

---

## 6. Response / privacy model

Implements discovery §5/§6's field-exposure table exactly, enforced inside the mapper functions (`mapProficiencyRow`, `mapStandingRow`), not left to callers or routes to remember:

- **`reason` is an allowlist, not a pass-through.** `REASON_ALLOWED_CAUSES = {EVIDENCE_REVOKED, EVIDENCE_REINSTATED}`, `REASON_ALLOWED_ACTIONS = {REVOKE, REINSTATE}`. Every other cause/action forces `reason: null` in the response regardless of what the underlying row holds — closing the exact leak discovery §6 found: `capabilityBackfill.ts`'s `BASELINE` writer hardcodes an internal migration-metadata string (`"Phase 30.2 backfill — establishes history for a pre-existing projection; not a live transition"`) onto every row it writes.
- **`actorName` exists only on `EvidenceStandingHistoryItem`, only for instructor/org viewers, and is *omitted* (not nullified) for the learner** — `if (includeActorName) item.actorName = row.actorName;`. `ProficiencyHistoryItem` never carries a name field at all, since `SkillProficiencyEvent` itself has no such column (discovery §5's corrected finding).
- No `tenantId`, no raw `actorId`, no raw `sourceId`, no event-row `id` in any response item — confirmed by a dedicated privacy test that `JSON.stringify`s a full response and asserts the tenant id, learner id, and actor id never appear as substrings anywhere in it.
- `sourceContext.courseTitle` is resolved live at read time through the same `resolveSourceCourse`-equivalent chain verification already uses, never through a `courseId`/`quizId`-only lookup — the exact class of join that caused D24 (discovery §6/§11's locked constraint). **This was under-tested in an earlier pass of this report** — a first version of the cross-tenant privacy test created a foreign course that no evidence actually pointed at, so it could not have caught a regression (removing the `tenantId` predicate from `batchResolveSourceContext`'s queries would have passed it unchanged). The test now directly constructs the malformed shape contract B8 exists to guard against — a tenant-A `SkillEvidence` row whose `sourceId` points at a tenant-B course, inserted directly since `verifyEvidence` itself already refuses this via 30.3's own course-tenant check — and asserts both that the foreign title never appears in the response JSON and that `sourceContext.courseTitle` resolves to `null` rather than leaking. A second test does the same for the `Quiz` branch, whose nested `lesson.section.course.tenantId` predicate is structurally different from the `Course` branch's top-level one.

---

## 7. Pagination

Cursor: opaque `base64(JSON)`, one shared codec inside `history.ts` (discovery §13's own reasoning: all three scopes here share identical position semantics, unlike `instructorReport.ts`/`organizationReport.ts`'s deliberately-decoupled *files* — a distinction the discovery itself drew and this report keeps). Three payload shapes, tagged by an `m` (mode) field:

```
{ m: "seq", seq: number, id: string }       — single-skill PROFICIENCY_CHANGED
{ m: "rev", rev: number, id: string }       — single-evidence EVIDENCE_STANDING_CHANGED
{ m: "rec", t: ISOString, id: string }      — every other case
```

**A cursor's mode is checked against the current request's filters, not trusted.** `decodeCursor(raw, expectedMode)` throws `HistoryCursorError` (400) if the cursor's own `m` doesn't match the mode the current filters compute — proven by a dedicated test: a cursor issued while filtering to one skill (`seq` mode) is rejected when replayed against an unfiltered request (`recorded` mode), rather than silently reinterpreted.

`DEFAULT_LIMIT = 50`, `MAX_LIMIT = 100` — the exact constants `instructorReport.ts`/`organizationReport.ts` already use, not new numbers.

**Combined-feed merge** (discovery §18): `limit + 1` fetched from each in-scope table, concatenated, sorted in application code by the active mode's comparator, cut to `limit`, `nextCursor` derived from the last retained item's own position. Proven stable under a genuine same-millisecond tie by two dedicated tests that construct the tie explicitly rather than hoping for one: a single-table test creating two `SkillProficiencyEvent` rows with an *identical* `recordedAt`, and a cross-table merge-boundary test with tied `recordedAt` across `SkillProficiencyEvent` and `EvidenceStandingEvent` plus an older row, which pins that the JS `compareDesc` merge order agrees with Postgres's keyset order at the page boundary. The `id` tie-break relies on the database collation; it was measured on `lumio_test` only (`en_US.UTF-8`). Neon's collation is unmeasured.

**Stability under a concurrent insert** is proven by three concrete assertions, not an always-true timestamp comparison: page 2 (fetched via page 1's cursor) is a genuinely different item than page 1's; a `REVOKE` event inserted between the two fetches does not appear in page 2 (it sorts ahead of the cursor); a fresh, no-cursor fetch from the top does include it (proving it was correctly excluded, not lost).

---

## 8. Filtering

`skillId`, `type` (`PROFICIENCY_CHANGED | EVIDENCE_STANDING_CHANGED`, validated against a closed list, 400 on anything else), `from`/`to` (§9 below), and — instructor/org routes only — `evidenceId`. No free-text search, no boolean composition, matching discovery §14/task §15's explicit rejection of arbitrary query syntax. Every filter is applied at the query level, never post-fetch.

**`evidenceId` applies as an equality predicate on both event-table queries, in every ordering mode** — not only when the combination of filters happens to select `revision` mode. An earlier implementation pass conditioned it on `mode === "revision"` specifically, which silently ignored the filter for every other combination (`evidenceId` alone, or `evidenceId` + `type=PROFICIENCY_CHANGED`) — a real bug, found and fixed during this report's own review (§13). For the instructor scope, a requested `evidenceId` is checked against the authorized-evidence set once, before any query runs, in every mode — not only inside the narrower `revision`-mode branch.

---

## 9. Date semantics

`occurredAt` (business time) is the filtered field, per discovery §15 — never `recordedAt`. Range is `[from, to)`, `from` inclusive, `to` exclusive.

**Parsing is deliberately strict**, closing a real hazard a naive `new Date(raw)` would have: only `YYYY-MM-DD` (read as UTC midnight) or a full ISO timestamp with an explicit `Z`/offset are accepted; anything else — including a bare local-time-shaped string like `2026-03-01T00:00` — is rejected with 400, never silently interpreted in the server's own local timezone. Tested directly at the route level (`bad from date (local-time string, no Z/offset) -> 400`).

---

## 10. Deleted/archived behavior

| Scenario | Behavior | Verified by |
|---|---|---|
| Soft-deleted learner (instructor/org) | 404, not a partial result | dedicated test, both scopes |
| Foreign-tenant learner | Same 404 as missing | dedicated test, both scopes |
| Legacy `QuizAttempt`-sourced evidence | Still resolves, matching `resolveSourceCourse`'s own fourth branch | dedicated test |
| Evidence with an unresolvable source (deleted quiz/lesson) | Fail-closed out of the **instructor's** view (cannot re-confirm ownership); still visible to the learner/org with `sourceContext.courseTitle: null` | dedicated instructor-side test; the learner/org-side graceful-`null` path is exercised directly by §6's malformed-source test |
| `BASELINE`/`RECALCULATED` proficiency events (`evidenceId = null`) | Invisible to the instructor's `evidenceId`-filtered view, by construction — never fixed up or special-cased | dedicated test |

No deleted entity is ever resurrected in a response — a deleted actor's row already degrades to `actorRole` + (on `EvidenceStandingEvent`) the point-in-time `actorName` snapshot 30.3 built for exactly this; nothing in this phase reads a live `User` row for display purposes.

---

## 11. Performance / query behavior

**Batched resolution** (discovery §20): `batchResolveSourceContext` groups evidence rows by `sourceType` and issues at most one `findMany` per type actually present (`Course`, `Quiz`, `QuizAttempt`, `AssignmentSubmission` — all four of `resolveSourceCourse`'s branches, including the legacy one), each with the tenant predicate baked directly into the query — never a post-fetch tenant check, so a malformed `sourceId` cannot pull another tenant's course title into a response (discovery §6's privacy table, "Source metadata" row). The cross-tenant guarantee is proven for the `Course` and `Quiz` branches by mutation-killed tests; the `QuizAttempt` and `AssignmentSubmission` branches use the same nested-tenant pattern but have no cross-tenant test.

**Empty authorized-evidence-id set short-circuits before any event query runs**, proven by a dedicated `vi.spyOn`-based test (an instructor who genuinely shares an enrollment with a learner who has zero evidence attributable to that instructor's own courses): both `skillProficiencyEvent.findMany` and `evidenceStandingEvent.findMany` are asserted never called. This guard is a pure round-trip-avoidance optimization, not a correctness requirement (Prisma's own `evidenceId: { in: [] }` already returns zero rows with or without it) — the test exists specifically to make that optimization's own purpose observable, since a data-correctness assertion alone cannot distinguish the guard being present from absent.

**Query-count test**: a fixture with 8+ evidence rows across multiple courses, `vi.spyOn` on every Prisma model method the module touches, confirms the call count at `limit=1` and `limit=100` differ by at most a small constant (some variance is legitimate and data-dependent) and stays under 15 in both cases.

**EXPLAIN ANALYZE**, run directly against `lumio_test` (read-only, no Neon) for the actual query shapes this module issues:

```
SELECT * FROM "SkillProficiencyEvent"
WHERE "tenantId" = $1 AND "userId" = $2
ORDER BY "recordedAt" DESC, "id" DESC LIMIT 51;
```
→ `Index Scan using "SkillProficiencyEvent_tenantId_userId_skillId_recordedAt_idx"`, 0.542ms execution.

```
SELECT * FROM "EvidenceStandingEvent"
WHERE "tenantId" = $1 AND "userId" = $2
ORDER BY "recordedAt" DESC, "id" DESC LIMIT 51;
```
→ `Index Scan Backward using "EvidenceStandingEvent_tenantId_userId_recordedAt_idx"`, 0.517ms execution.

Both plans use the existing composite indexes as a usable prefix even without a `skillId` filter — confirming discovery §19's finding that the flagged-but-not-built additional indexes are not urgently needed for the query shapes this phase actually issues. **No index was added.**

---

## 12. Test coverage

| Suite | Count | Result |
|---|---|---|
| `history.test.ts` (domain) | 56 | all pass |
| `src/app/api/capability/history/route.test.ts` | 11 | all pass |
| `src/app/api/instructor/capability/[learnerId]/history/route.test.ts` | 9 | all pass |
| `src/app/api/org/capability/[learnerId]/history/route.test.ts` | 7 | all pass |
| **Total, this phase** | **83** | **all pass** |

Domain tests run against the real database (matching this repo's own established convention for capability-domain tests — a mocked domain layer cannot prove no data leaked, only that a typed shape came back). Route tests mock the domain layer and auth context, following the exact pattern `org/capability/route.test.ts` already established — status-mapping, validation, and error-serialization only. **The `evidenceId`-filter bug (§13) is the concrete proof of why that split matters**: the route test "passes evidenceId filter through" mocks the domain layer and only proves the value reaches the function call, not that the function actually uses it — the bug lived entirely inside the mocked-away domain layer. It was found during this report's own review pass, then confirmed with new failing domain tests and two mutants (#13/#14) before being fixed — not discovered by the mutation pass itself, which only came after the fix to prove it held (§13's own account is the accurate one; this is restated here so the two sections agree).

Categories covered, matching the task's own §25 list: domain authorization (all three scopes + explicit SUPER_ADMIN exclusion), event mapping, the privacy allowlist, ordering (all three modes, including mutation-driven boundary regressions), filtering (including the `evidenceId`-in-every-mode fix), cursor construction/tampering/mode-mismatch, foreign-tenant and soft-deleted-user handling, legacy source resolution, invalid cursor/filter validation at the API layer, pagination-under-authorization-filtering, performance/query-count (including the empty-set short-circuit), and the read-only invariant (full four-table snapshot, deep-equal before/after every endpoint call in one test).

---

## 13. Mutation results

Nineteen targeted mutants, following this session's established manual-script convention (exact-string-replace against the final code, run `history.test.ts`, restore, verify byte-identical restoration, delete script before finishing). **Reported as what actually happened, across several rounds, not just the final clean tally — including a round that exposed both an under-specified earlier mutant and a real functional bug in the code itself.**

**Round 1 — first-draft implementation, mutants #1-#12:** survivors were **#1, #6, #7, #8, #10, #11**, plus #12 initially skipped by a pattern-match issue in the script (later confirmed manually). Each investigated:
- #1 (tenant predicate on the proficiency query) and #11 (instructor enrollment's `course.tenantId` check) needed a *defense-in-depth* test — a spoofed `ctx.tenantId` alongside a real `userId`/`instructorId`, since every test built from a genuine `AuthContext` has tenant/user always mutually consistent, which is exactly why the redundant tenant predicate is invisible to an ordinary test.
- #6 (cursor off-by-one) and #10 (tie-break direction) needed the `recorded`-mode code path specifically isolated — an earlier test accidentally exercised `seq` mode instead, by passing both `type` and `skillId` together.
- #7 (ordering direction) needed real timing ambiguity removed via explicit `recordedAt` values — real writers can land in the same test-execution millisecond, which makes an ascending-vs-descending assertion pass by accident on tied data.
- #8 (`skillId` filter) needed a fixture where the *other* skill actually had real events for the same learner — an empty other-skill has nothing to leak, so removing the filter was unobservable.
- #12 (`BASELINE` allowlist) was already caught by the existing `BASELINE`-privacy test once the pattern-match issue was fixed; no new test needed.

All six fixed with new or corrected tests; a re-run of all 12 confirmed 12/12 killed at that point.

**Round 2 — this report's own review pass surfaced a genuine functional bug**, found by inspection, not by a mutant: `fetchAndMerge` applied `filters.evidenceId` as a query predicate only when `mode === "revision"`, silently dropping it in every other mode (`evidenceId` alone, or `evidenceId` + `type=PROFICIENCY_CHANGED`). This was fixed first, then two new mutants (**#13**, **#14**, reverting the fix on the proficiency and standing queries respectively) were written to prove the fix actually mattered. #14 (standing query) was killed on the first try. #13 (proficiency query) **survived once**, against an under-discriminating test fixture — `setupScenario`'s shared-skill data happened to make the filtered and unfiltered result sets identical — and was killed only after that test was rewritten to use two evidence rows on two genuinely different skills. Three new domain tests were added for the fix itself.

**Round 3 — re-running the original #1-#12 set against the fixed file.** #1 through #8, #10 and #11 all re-killed cleanly. **#9**, redefined this round as removing only the empty-authorized-evidence-id short-circuit guard in the proficiency query, came back **survived**. On inspection this was not a regression: Prisma's own `evidenceId: { in: [] }` already returns zero rows whether or not the JS-level guard is present, so no data-correctness test can distinguish the guard's presence from its absence — its only purpose is skipping a wasted, always-empty database round trip. A dedicated `vi.spyOn` test was added (an instructor who genuinely shares an enrollment with a learner who has zero evidence attributable to that instructor, asserting neither event table's `findMany` is ever called), which kills the guard-only #9 and documents it as a performance guarantee, not a correctness one — not accepted as equivalent, given a real test now exists.

**Correction to the round-1 record of #9:** the replacement string used for #9 in round 1 also dropped the `evidenceIdIn` spread from the query's `where`, so what round 1 actually ran under the "#9" label was an `IN`-removal mutant, not the guard-only mutant the label described. Round 3's guard-only #9 was therefore a different mutant from round 1's, and it is the one that survived until the spy test existed.

**Round 4 — restoring `IN()` coverage explicitly and covering `batchResolveSourceContext`'s tenant predicate, which had no mutant at all.** Because the guard-only #9 no longer exercised the `IN()` allow-list, and the source-resolution tenant predicate was unmutated, four new mutants were added directly against the final code and test suite (then a fifth, #19, for the Quiz branch):

| # | Mutant | Result |
|---|---|---|
| 15 | `batchResolveSourceContext`'s `Course` branch drops its `tenantId` predicate | Killed — by the Course-branch cross-tenant privacy test (§6), which constructs a real malformed tenant-A-evidence-pointing-at-tenant-B-course row rather than an unreferenced foreign course |
| 16 | Authorization moved from the query's own `WHERE evidenceId IN (...)` to a post-fetch filter in `getInstructorLearnerHistory` (the exact "fetch page, then filter" anti-pattern discovery §7/§14 exists to forbid) | Killed — by the pagination-under-authorization test (small pages must still fill from authorized rows) and the empty-authorized-set spy test |
| 17 | The `evidenceIdIn` → `{ evidenceId: { in: ... } }` spread dropped entirely from `queryProficiencyPage` | Killed |
| 18 | Same, dropped from `queryStandingPage` | Killed |
| 19 | `batchResolveSourceContext`'s `Quiz` branch drops its `lesson.section.course.tenantId` predicate | Killed — by the Quiz-branch cross-tenant privacy test, which points a tenant-A evidence row's `sourceId` at a tenant-B quiz |

Also added, and now recorded as part of the ordering coverage rather than a mutation target: a dedicated **combined-merge boundary test** (discovery §28/task's own testing contract — "a page that straddles both source tables merges correctly, in true `recordedAt` order"), which had no direct test before this round. It creates one `SkillProficiencyEvent` and one `EvidenceStandingEvent` row sharing an identical `recordedAt`, plus a distinctly older third row, and pages through `getLearnerHistory` one item at a time until exhausted, asserting all three appear exactly once, in the exact order the module's own `compareDesc` comparator predicts. `lumio_test`'s collation was checked directly (`SELECT datcollate FROM pg_database` → `en_US.UTF-8`) rather than assumed — cuid ids use only lowercase ASCII `[0-9a-z]`, a charset for which this collation and JS's UTF-16-code-unit `<`/`>` comparison order identically, which is why the JS-side `compareDesc` tie-break and the Postgres-side keyset predicate can be trusted to agree at a real tie without needing to push the comparison itself into SQL.

**Round 5 — fresh final sweep against the final files.** The rounds-1–4 mutants above were killed in sweeps that predate the last test additions, so a new, broader 33-mutant sweep was written and run against the final `history.ts` and `history.test.ts` (exact-string replacement, restore, byte-identical check, script deleted afterwards). It covered every query predicate (tenant, skill, `evidenceId` equality and `IN`, empty-set guards), all cursor comparators, `compareDesc` direction and tie-break, `hasMore`, both reason allowlists, `actorName`, all cross-tenant lookups, the enrollment/soft-delete gates, and the date bounds. **First run: 27 of 33 killed, six survived** — real coverage gaps, not equivalent mutants:

| Survivor | Gap | Closed by |
|---|---|---|
| revision-mode cursor `lt` → `lte` | no test paged in `revision` mode | revision-mode pagination test (REINSTATE, REVOKE, VERIFY, one per page) |
| standing-row `reason` allowlist by action | only the cause-side allowlist was pinned by a non-REVOKE row that already held `reason: null` | direct-insert `VERIFY` row holding text; asserted absent from the JSON |
| date `to` `lt` → `lte` | no boundary test at an exact timestamp | `[from, to)` exact-boundary test |
| `batchSkillNames` tenant predicate | needs a malformed cross-tenant `skillId` | foreign-skill-name test |
| `skillEvidence` lookup tenant predicate in `toHistoryItems` | needs a malformed cross-tenant `evidenceId` | foreign-evidence test (`evidenceType` stays `"MANUAL"`, `courseTitle` null) |
| instructor evidence-set tenant predicate | needs an evidence row stored under another tenant | instructor test: such a row's event is never visible |

**Second run: 33 of 33 killed; file restored byte-identical.** These six gaps are defense-in-depth for malformed data (cross-tenant ids inside a single tenant's rows) plus two ordinary boundary gaps; none was a functional bug in well-formed data.

**Final tally: 33 of 33 mutants killed in the final sweep against the shipped files; the 19 named in rounds 1–4 were each killed at the time they were run. None accepted as equivalent** — the guard-only #9 was the one candidate for that status and was instead given a real, purpose-specific test. Source branches `QuizAttempt` and `AssignmentSubmission` have no mutant and no cross-tenant test (same nested-tenant pattern as the proven `Quiz` branch).

---

## 14. Security verification

Every item on the task's own §25 security list, and the discovery's own §22 table, checked directly:

- **User ID substitution**: structurally impossible on the learner route (no parameter); explicitly tested for the instructor/org routes (unrelated same-tenant learner, foreign-tenant learner — both 404).
- **Tenant ID substitution**: query-string `tenantId`/`userId` params are ignored (route tests assert the domain function is called with only the authenticated `ctx`, never a query-string override); the domain-layer defense-in-depth tests (§5) go further and prove the *query itself* fails closed even if a caller's `ctx.tenantId` were wrong.
- **Event ID enumeration**: no event-row `id` is ever returned in any response (confirmed by the `JSON.stringify` privacy tests).
- **Cursor tampering**: a structurally malformed cursor is rejected (400); a well-formed cursor with a mode mismatch is rejected; a cursor cannot grant access beyond what the request's own authorization predicates already allow, since every query re-applies the full tenant/scope predicate independent of cursor contents.
- **Unauthorized instructor access**: the dedicated §14-class (task numbering) pagination test proves this at the data level, not merely the authorization-gate level; the `evidenceId`-filter tests (§13) close the specific gap that let an unauthorized `evidenceId` slip through unfiltered outside `revision` mode.
- **Cross-tenant access**: covered throughout §5/§14.

---

## 15. D24 / BASELINE treatment

**No `SkillProficiencyEvent` row is ever written by this phase's production code** — `history.ts` calls only `.findMany`/`.findFirst` against both event tables, confirmed by the read-only invariant test (§12) and by direct inspection of the module (no `.create`/`.update`/`.upsert` call against either event table anywhere in it). Test fixtures in `history.test.ts` do call `db.skillProficiencyEvent.create`/`db.evidenceStandingEvent.create` directly (the tie-break and explicit-ordering tests, §7/§12) — that is test-only data setup, confined to each test's own freshly-created, throwaway tenant, not a claim about production code paths.

The discovery's own finding (§26: local D24 remediation never retroactively fixed already-written `BASELINE.occurredAt` values, since that table is append-only and remediation was deliberately scoped to `SkillEvidence` only) is represented **exactly as it is** — a `BASELINE`-caused `PROFICIENCY_CHANGED` item is returned with whatever `occurredAt` the row actually holds, correct or contaminated, and its `reason` is forced to `null` (§6) so the internal migration-metadata string never reaches a response regardless of the timestamp's own correctness. No synchronization, no timestamp rewriting, no special-casing beyond the reason redaction was added — the append-only table stays append-only.

The production remediation decision remains exactly where the discovery left it: out of this phase's scope, a deployment/data-readiness question for whenever Neon access and a decision to run it are both in hand.

---

## 16. Files changed

**New, this phase only — 8 code files plus this report:**
- `src/lib/domain/capability/history.ts` — domain read layer.
- `src/lib/domain/capability/history.test.ts` — 56 domain tests.
- `src/app/api/capability/history/route.ts` — learner endpoint.
- `src/app/api/capability/history/route.test.ts` — 11 tests.
- `src/app/api/instructor/capability/[learnerId]/history/route.ts` — instructor endpoint.
- `src/app/api/instructor/capability/[learnerId]/history/route.test.ts` — 9 tests.
- `src/app/api/org/capability/[learnerId]/history/route.ts` — org endpoint (the `[learnerId]` segment under `org/capability/` is itself new — no such subdirectory existed before this phase).
- `src/app/api/org/capability/[learnerId]/history/route.test.ts` — 7 tests.
- `docs/PHASE_30.4_IMPLEMENTATION.md` — this report.

**Modified:** none. Every pre-existing tracked file is untouched by this phase — `git diff --stat` against every tracked file matches Phase 30.3's own baseline byte-for-byte (`19 files changed, 3697 insertions(+), 366 deletions(-)`), confirming zero writer/schema/verification changes.

**Untracked baseline, precisely counted, not estimated:** `git status --short | grep -c '^??'` returns **17** total untracked entries. Breakdown: **10** belong to Phase 30.3's own baseline (`docs/PHASE_30.3_D24_REMEDIATION.json`, `docs/PHASE_30.3_DISCOVERY.md`, `docs/PHASE_30.3_IMPLEMENTATION.md`, the `EvidenceStandingEvent` migration directory, the generated `EvidenceStandingEvent.ts` model, `evidenceTransitions.ts`, `evidenceTransitions.test.ts`, `verification.transitions.test.ts`, `evidenceInvariant.test.ts`, `capability/evidence/[evidenceId]/verify/route.test.ts` — corrected here from an earlier draft of this report, which miscounted this set as 11). **1** is `docs/PHASE_30.4_DISCOVERY.md` from the prior turn. **6** are this phase's own new work (`docs/PHASE_30.4_IMPLEMENTATION.md`, `src/lib/domain/capability/history.ts`, `history.test.ts`, and three collapsed directory entries — `git status` shows one line per new directory, not per file inside it — for `api/capability/history/`, `api/instructor/capability/[learnerId]/history/`, and `api/org/capability/[learnerId]/`, together holding the 6 route/route-test files listed above). 10 + 1 + 6 = 17.

**No `prisma/schema.prisma` change. No new migration.** `npx prisma generate` was re-run to confirm this — `git diff --stat src/generated` shows exactly the same 12 modified files Phase 30.3 already produced, no new drift.

---

## 17. Deferred work

Restated from the discovery (§31/§32), not silently dropped:

- Two composite-index additions (`SkillProficiencyEvent`'s cross-skill index, `EvidenceStandingEvent`'s skill-scoped index) — this phase's own `EXPLAIN ANALYZE` (§11) confirms they are not urgently needed at current `lumio_test` volume; still flagged for whenever real production query-plan data justifies them.
- UI integration (learner/instructor/org "History" views) — explicitly out of scope, not designed further here.
- Read-access auditing of the history endpoints themselves — deliberately not built (discovery §27), no mechanism exists to hang it on yet.
- AI-specific history consumption — none built; any future AI context module would call these same three functions through the same authorization boundary, not a parallel API (discovery §25).
- A dedicated remediation for already-written `BASELINE.occurredAt` rows (discovery §26's own finding) — real, out-of-scope follow-up, not resolved by this phase's `reason`-redaction fix, which addresses only the metadata leak, not the timestamp's own correctness.

---

## 18. Known risks

- **This implementation went through several review-driven correction rounds before this report could be trusted** (§13): a real functional bug (the `evidenceId` filter silently ignored outside `revision` mode) and two under-verifying tests (a vacuous cross-tenant privacy check, a tautological pagination-stability assertion) were all found and fixed during review, not before. This is disclosed as a known-risk class, not just a historical note: it means the *first* pass of both the code and this report were not reliable, and the discipline of a mutation pass plus a skeptical re-read of each test's own assertions is what actually caught the gaps — future changes to this module should keep both.
- **The instructor's `evidenceId`-based pre-filter necessarily makes `BASELINE`/`RECALCULATED` proficiency events invisible to instructors, permanently** — a deliberate, discovery-approved consequence (§7), not a bug.
- **Cross-entity `recorded`-mode ordering carries the same unquantified, not-provably-safe timestamp-based pagination risk `adminAssignments.ts` already carries** (discovery §12) — accepted as matching an existing, already-shipped convention, not newly introduced or newly resolved by this phase.
- **`lumio_test`'s own accumulated fixture noise** (thousands of `BASELINE`/test-only rows from five phases of this session's own work) was never queried broadly by any test in this phase — every domain test creates and scopes to its own fresh tenant, so this noise cannot leak into a false pass, but it does mean the `EXPLAIN ANALYZE` numbers in §11 reflect a modestly-sized real table, not a synthetic stress test; genuine production-scale query-plan behavior remains unmeasured (no Neon access).

No critical issue remains around tenant isolation, authorization, privacy, pagination correctness, event ordering, N+1/performance, deleted-source handling, or response contract — each was directly tested, and the mutation passes (§13) found and closed every gap they surfaced, including the one genuine functional defect.

---

## 19. Final validation

| Check | Result |
|---|---|
| Focused capability-history tests | 83/83 pass (§12) |
| Full repository test suite | 182 files, **3439/3439 pass on a clean run** (after all test additions, fresh `pnpm install --frozen-lockfile`, `lumio_test`). One pre-existing test, `src/app/api/cron/downgrade-subscriptions/route.test.ts` ("two runs executing at the same time downgrade a tenant exactly once", `[1, 1]` vs expected `[0, 1]`), is flaky: in this final validation it failed in 4 of 5 full-suite runs and 5 of 8 isolated runs, and passed cleanly in the rest. No file in this phase's diff touches the cron route or its domain code, so it is unrelated; it is reported, not fixed (out of scope). Every other test passed in every run. |
| Mutation testing | 19/19 rounds-1–4 mutants killed, plus a fresh 33/33 final sweep (§13) |
| `npx tsc --noEmit` | 0 errors |
| `npx prisma validate` | schema valid (unchanged) |
| `npx prisma generate` | regenerated client, `git diff --stat src/generated` unchanged from Phase 30.3's own baseline |
| `pnpm build` | succeeds; all three new routes present in the route manifest (`/api/capability/history`, `/api/instructor/capability/[learnerId]/history`, `/api/org/capability/[learnerId]/history`) |
| `npx biome check` (new files) | 0 errors, 0 warnings |
| `npx biome check .` (repo-wide) | 53 warnings + 1 format finding, both pre-existing and entirely in files this phase never touched (the 1 "error" is a JSON-format-only finding on `docs/PHASE_30.3_D24_REMEDIATION.json`, a Phase 30.3 data artifact) |
| Neon accessed | **No** — every check ran against `lumio_test`, `DATABASE_URL` pinned explicitly on every DB-touching command |
| Diff check | `git diff --stat` on tracked files matches Phase 30.3's own baseline exactly (19 files, +3697/-366); `git status --short` shows 17 untracked entries (directories collapsed): Phase 30.3's own 10, plus this phase's 7 (`PHASE_30.4_DISCOVERY.md`, this report, `history.ts`, `history.test.ts`, and the three route directories containing 3 route files + 3 route tests) |

**Repository hygiene:** `git status --short` inspected before finishing — no file outside the eight new Phase 30.4 code files (plus the already-existing `PHASE_30.4_DISCOVERY.md` and this report) was touched. Nothing committed. Nothing pushed.

---

## 20. Final status

```text
PHASE_30.4 COMPLETE
```
