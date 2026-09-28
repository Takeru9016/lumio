# Phase 30.3 — Recency, Confidence, Verification & Invalidation: Contract Discovery

Status: discovery only. No Prisma schema, migration, production code, API or UI change accompanies this document.
Builds on `docs/PHASE_30.1_IMPLEMENTATION.md` (`PHASE_30.1 COMPLETE`) and `docs/PHASE_30.2_IMPLEMENTATION.md` (`PHASE_30.2 COMPLETE`). Read against repository HEAD `f9b39b9` ("feat: implement Phase 30.2 runtime capability writers, historical backfill, and event reconciliation").

How to read this document: every claim about current behavior is **[code]** (read directly, cited by file:line), **[test]** (locked by a named test), **[derived]** (follows from the code's structure but not reproduced live — same convention the 30.0 pre-flight used for the `UserSkill` lost-update race), or **[verified this session]** (re-confirmed by grep/read this session, not merely inherited from the 30.0 pre-flight). Where this session's findings correct or add to the pre-flight audit, that is stated explicitly.

**Numbering note — exact mapping, so it cannot drift:** this document has 36 sections against the task's 33 required content items (its own §34). Two sections are additions this session's findings required and have no task-list counterpart: **§11** (Verifier independence — supporting detail for task item 10) and **§14** (the check-then-write/idempotency structural gap — the finding that motivates §15's transition table). Every other section maps 1:1, in order, once those two insertions are skipped:

| Task item | Doc § | Task item | Doc § | Task item | Doc § |
|---|---|---|---|---|---|
| 1 | §1 | 12 | §12 | 23 | §25 |
| 2 | §2 | 13 | §13 | 24 | §26 |
| 3 | §3 | 14 | §16 | 25 | §27 |
| 4 | §4 | 15 | §17 | 26 | §28 |
| 5 | §5 | 16 | §18 | 27 | §29 |
| 6 | §6 | 17 | §19 | 28 | §30 |
| 7 | §7 | 18 | §20 | 29 | §31 |
| 8 | §8 | 19 | §21 | 30 | §32 |
| 9 | §9 | 20 | §22 | 31 | §33 |
| 10 | §10 | 21 | §23 | 32 | §34 |
| 11 | §15 | 22 | §24 | 33 | §35 |

(§36 is the task's own required final-gate block, unnumbered in its list.) Every cross-reference in this document (`§N`) refers to this document's own numbering, not the task's.

---

## 1. Current post-30.2 behavior

Re-verified this session, not assumed from the prior documents:

- **A confirmed defect in already-shipped 30.2 code, found and empirically proven this session, directly relevant to 30.3's freshness/confidence contract: the backfill's `occurredAt` fill cross-contaminates evidence between different learners of the same course or quiz.** `capabilityBackfill.ts`'s `fillMissingEvidenceMetadata` (`:92-132`) resolves `COURSE_COMPLETION` evidence's `occurredAt` by querying `db.enrollment.findMany({ where: { courseId: { in: courseSourceIds } } })` — **filtered by `courseId` only, with no `userId`** — then folds the results into `earliestByCourse: Map<courseId, Date>`, which `.set()`s once per row in arbitrary DB iteration order, so **the last-iterated enrollment for that course wins for every learner's evidence row on that course**, not each learner's own. The `QUIZ_SCORE` lookup has the identical shape (`quizId`-only filter, no `userId`), though there it deterministically takes the *earliest* passer's timestamp for everyone (via `orderBy: completedAt asc` plus `if (!earliestByQuiz.has(...))`), which is scoped wrong but at least consistent. **The bug itself is certain [code] — no `userId` filter, a `Map` keyed only by `courseId`/`quizId`. Its magnitude in this specific database is empirically small, and that smallness is itself explained, not left as an unexamined "0 mismatches" result.** A first, coarser query (comparing each learner's own `occurredAt` to their own `completedAt`, tolerance 5 seconds) found **zero** rows over the threshold — which does not mean the bug doesn't fire, only that in this database the values it collapses onto happen to be close together. A second query found the real signature: 73 distinct courses have `SkillEvidence` rows whose learners hold more than one distinct `Enrollment.completedAt` among them, but fewer distinct `occurredAt` values than that on their evidence. **Discriminated directly on the sample course this session** (`cmu8nz6a4006kxk6laa7e18da`, `psql`, read-only): its 3 learners' true `completedAt` values are `17:31:21.873`, `.874`, `.875` — three enrollments completed one millisecond apart, plainly fixture-generated in a tight loop, not real usage — and all 3 `SkillEvidence` rows show `occurredAt = .875`, meaning **2 of the 3 learners' evidence carries another learner's timestamp, off by 1-2 milliseconds from their own true value.** This confirms the mechanism fires exactly as read from the code, and is not a false positive from a test that happened to pass one shared timestamp to the live writer. **The 1-2ms error size is an artifact of this database's fixture-generation pattern (enrollments created back-to-back in a test loop), not evidence the bug is harmless — in production, where real course completions are spread over days or months, the same mechanism would silently assign one learner's evidence the completion date of an unrelated classmate, a large and directly freshness-relevant error.** Production magnitude is unmeasured here (no Neon access, §0-style caveat inherited from every prior phase). The `QUIZ_SCORE` lookup has the identical unfiltered shape and was not separately discriminated to the same row level this session — its 73-course-equivalent signature (multiple quiz-evidence rows collapsing onto one shared `occurredAt`) was confirmed by the same class of query, but not traced to an exact millisecond-level sample the way the course case was; treat it as the same defect, same mechanism, unconfirmed at the same level of detail. `AssignmentSubmission`-sourced evidence and legacy `"QuizAttempt"`-sourced evidence are unaffected (both keyed by their own row id, already unique per learner). **Consequence for this phase:** §6/§8's freshness calculation (`now - occurredAt`) is wrong for every contaminated row, which can silently push `confidenceFor` between `HIGH`/`MEDIUM`/`LOW` incorrectly; the `BASELINE` `SkillProficiencyEvent`'s own `occurredAt` (for a row whose backfill also ran) inherits the same wrong value; and contract B5's "content is immutable, `occurredAt` never rewritten once set" plus `fillMissingEvidenceMetadata`'s own `updateMany({where: {occurredAt: null}})` guard mean **a future, fixed backfill run cannot self-correct any row this bug already touched** — those rows are permanently wrong unless explicitly, deliberately re-derived outside the normal "fill nulls only" rule. **Not fixed in this discovery pass** (no production code changes permitted this phase) — specified as **D24** (§34): re-key both lookups by `(courseId, userId)`/`(quizId, userId)` respectively (`Enrollment` is already unique on `[userId, courseId]`) before any further production backfill run, and treat any environment where backfill has already run (this repository's own `lumio_test`, and — unknown to this session — possibly Neon, if 30.2's backfill was ever run there) as needing an explicit, one-time, `occurredAt`-only re-derivation pass that is deliberately exempt from B5's "never rewrite once set" rule for exactly this correction. **This is the single most consequential finding in this document and should be resolved (or its urgency confirmed against production) before 30.3 relies on `occurredAt`-derived freshness for anything user-visible.**
- **`projectUserSkill`** (`src/lib/domain/capability/proficiency.ts:79-218`) is the one writer of `UserSkill.proficiency`. It locks the row (`SELECT ... FOR UPDATE`), reads the full evidence set, computes via `proficiencyPolicy.ts` (Policy 1 — type-agnostic `ceilingFor`), writes the projection, and appends a `SkillProficiencyEvent` **iff the level changed** (task 30.2 §7, over contract F5's literal text). A no-op recompute still refreshes `evidenceConfidence`/`policyVersion` as cache fields, but writes no event.
- **Two callers**, both unchanged in transaction boundary since before 30.2: `outcomes.ts:recordSkillEvidenceOutcome` (evidence creation) and `verification.ts:setEvidenceVerificationStatus` (verify/reject).
- **`verification.ts` is functionally V1**, plus exactly one field: `revision: { increment: 1 }` on both the VERIFIED and REJECTED branches (30.2 §8, to keep `SkillProficiencyEvent`'s `[evidenceId, evidenceRevision]` constraint from colliding on a verify-then-reject sequence). Every other line — the two-action union (`verify`/`reject` only), the ownership/tenant/source-resolution authorization chain, the unconditional overwrite of `verifiedById`/`verifiedAt` on a second verify, the absence of any precondition on the current `verificationStatus` — is byte-for-byte what Phase 5/20 shipped. **[verified this session: `verification.ts` read in full; no `unverify`, `reopen`, `revoke`, `reinstate`, `PENDING`-handling, or CAS-on-`revision` logic exists anywhere.]**
- **`state`, `validUntil` on `SkillEvidence` have zero writers anywhere in production code.** `grep -rn "validUntil" src --include="*.ts"` outside `/generated/` and `*.test.ts` returns only *readers* (`proficiency.ts`, `proficiencyPolicy.ts`, `capabilityBackfill.ts`, `policyReconciliation.ts`). `grep` for a literal `state:` write against `EvidenceState`'s values returns zero hits anywhere outside the Prisma default. **Every row that exists — including every row Phase 30.2's backfill or the live writers create today — is `state = ACTIVE`, `validUntil = null`.** **[verified this session, corrects nothing in the prior documents but confirms their "schema only" claim still holds after 30.2.]**
- **No production code path contains the words `supersede`, `revoke`, or `invalidate`** anywhere under `src/lib/domain/capability` outside test files. **[verified this session.]**
- **`SkillEvidence.assessedLevel` and `.supersededById` do not exist in the schema.** 30.1 §2 explicitly deferred them to 30.8, on the grounds that Policy 1 never reads them. **This makes the task prompt's framing of "supersession" (§21, "The schema contains `supersededById`") factually wrong as written** — it does not. Section 18 below treats supersession as **not yet schema-backed**, not as an existing column to wire up.
- **Confidence (`UserSkill.evidenceConfidence`) is live**, computed by `confidenceFor` (`proficiencyPolicy.ts:154-175`) on every recompute and stored as a cache field, exactly as 30.2 shipped it. It is never an input to `proficiency`. **[code, re-read this session]**
- **`AdminAuditLog` has no `tenantId` column** (`prisma/schema.prisma:945-959`) and its `action` field is constrained application-side to a fixed union (`AdminAction` in `src/lib/admin-audit.ts`: `TENANT_SUSPENDED | TENANT_REACTIVATED | USER_ROLE_CHANGED | USER_PLAN_CHANGED`). `logAdminAction` is a plain, synchronous `db.adminAuditLog.create` — not wrapped in its own transaction with anything else, not best-effort. **[verified this session — the pre-flight's §27 treatment of `AdminAuditLog` as "platform actions only" is confirmed structurally, not just by convention: it cannot represent a tenant-scoped, per-skill capability transition without a schema change of its own (no `tenantId`, no `SkillEvidence` target type, a closed action enum).]**
- **`Course` has no `deletedAt`; archival is `status = ARCHIVED`.** No application route deletes a `Course` directly (`grep -rnE "\.(course)\.delete(Many)?\(" src --include="*.ts"` outside tests: zero hits, verified this session). `Enrollment.userId`/`Enrollment.courseId` are both `ON DELETE RESTRICT` at the database level (`prisma/migrations/20260627033933_init/migration.sql:429,432`, read directly this session) — **not cascade**, correcting an assumption this document's own first draft made. A `Course` or `User` with any `Enrollment` row cannot be hard-deleted at all; Postgres refuses the statement with a foreign-key violation. The same RESTRICT applies to `QuizAttempt.userId`/`AssignmentSubmission.userId` (`migration.sql:447,462`) — a learner with any recorded attempt or submission likewise cannot be hard-deleted while those rows exist. `SkillEvidence.userId`/`UserSkill.userId`, by contrast, are `ON DELETE CASCADE` (`20260909180000_.../migration.sql:517,526`), so **in practice a `User` hard-delete is blocked upstream by `Enrollment`/`QuizAttempt`/`AssignmentSubmission` long before the capability tables' own cascade would ever run** — the capability tables' CASCADE is reachable only for a learner who was never enrolled/never attempted anything, which by definition has no evidence anyway. This resolves the "deleted user" row the task's §17 table asks for: soft-delete (`deletedAt`) is the only practical path (§16, learner-`deletedAt` gap), because hard-delete is structurally blocked while capability-relevant activity exists.
- **A real, live source-disappearance path exists today, found by reading the actual delete routes, not assumed:** `db.section.delete` (`src/app/api/courses/[courseId]/sections/[sectionId]/route.ts:72`) and `db.lesson.delete` (`.../lessons/[lessonId]/route.ts:144`) are real, reachable, course-owning-INSTRUCTOR-authorized endpoints, confirmed this session to have **no precondition check** for existing `QuizAttempt`/`AssignmentSubmission`/enrollment activity before deleting (`route.ts:122-147`, read in full — the only checks are ownership and existence). `Lesson→Quiz`/`Lesson→Assignment` are `ON DELETE CASCADE` (`migration.sql:426,441,459`), and critically, `QuizAttempt.quizId`/`AssignmentSubmission.assignmentId` were changed from `RESTRICT` to **`ON DELETE CASCADE`** by a later migration (`20260630175327_lesson_archive_cascade_fixes/migration.sql:20,26`, confirmed this session). **Deleting a lesson today silently cascades through `Quiz`/`Assignment` to delete every `QuizAttempt`/`AssignmentSubmission` row for it — orphaning any `SkillEvidence` row whose free-form `sourceId` pointed at one, with no signal, no revocation, and no event.** This is the concrete, already-reachable instance of the "source deleted" scenario §16 discusses — not a hypothetical one gated on a route that doesn't exist yet.

---

## 2. Vocabulary

The task requires these not be conflated. Restated precisely against what is actually implemented (not just proposed):

| Concept | Definition | Where it lives today |
|---|---|---|
| **Exists** | A `SkillEvidence` row is present, any state. | The row. |
| **Valid** | `isEvidenceValid` (`proficiencyPolicy.ts:64-69`): `state === "ACTIVE"`, `verificationStatus !== "REJECTED"`, `validUntil` null or in the future. Tenant consistency is **not** checked here (a pure, DB-free function) — it is the caller's query-scope responsibility, same posture as V1. | `proficiencyPolicy.ts` |
| **Contributes** | `doesEvidenceContribute` (`:82-84`): valid AND `ceilingFor(e) !== "NONE"`. Under Policy 1 this is always equal to "valid" (the only NONE grant is REJECTED, already excluded by validity) — the two are computed as separate steps anyway, because a type-aware grant table would make them diverge (a reserved type could be valid but grant NONE). | `proficiencyPolicy.ts` |
| **Verification** | Whether `verifyEvidence`/`rejectEvidence`'s authorized actor set (course-owning INSTRUCTOR; SUPER_ADMIN, tenant-bound — see §10) has confirmed the row. `verificationStatus ∈ UNVERIFIED, PENDING, VERIFIED, REJECTED`. `PENDING` has zero writers (confirmed again this session). | `verification.ts` |
| **Rejection** | `verificationStatus = REJECTED`. Today the *only* lowering action that exists. Excludes the row from validity permanently — there is no path back (no `reopen`). | `verification.ts` |
| **Revocation** | **Does not exist as a distinct action.** `EvidenceState.REVOKED` is a declared enum value with zero writers. The task's §16 distinction ("REJECTED = not accepted; REVOKED = was accepted, no longer valid") is a proposal for 30.3, not current behavior. | n/a today |
| **Supersession** | **Does not exist.** No column (`supersededById`), no writer, no reader. Proposed only for 30.8's assessed-level evidence. | n/a today |
| **Freshness** | `isFresh` (`proficiencyPolicy.ts:126-133`): an explicit `validUntil` in the future, or (absent one) `now - occurredAt <= 365 days`. Feeds `confidenceFor` only — never contribution, never level. | `proficiencyPolicy.ts` |
| **Confidence** | `confidenceFor`'s categorical `LOW \| MEDIUM \| HIGH \| null`, a cache on `UserSkill.evidenceConfidence`, recomputed on every real recompute (never on a pure clock tick — see §6/§28 on staleness). | `proficiencyPolicy.ts`, `proficiency.ts` |

State diagram, `EvidenceState` × `verificationStatus` (the two independent axes the schema already declares, contract §E preamble):

```
verificationStatus:  UNVERIFIED ──verify──> VERIFIED ──reject──> REJECTED
                          ^                     |
                          └──────reject─────────┘
                     (no un-verify, no reopen, no PENDING writer — today)

state:               ACTIVE ──(no writer today)──> SUPERSEDED / EXPIRED / REVOKED
                     (proposed for 30.3/30.8 — see §3)
```

---

## 3. Evidence state machine

**Recommendation: keep exactly the four declared `EvidenceState` values (`ACTIVE`, `SUPERSEDED`, `EXPIRED`, `REVOKED`) as the ceiling of the state axis for 30.3, but only wire up `ACTIVE ⇄ REVOKED` this phase.** `SUPERSEDED` stays unwritten until 30.8 (§20 — it has no trigger without `assessedLevel`/`supersededById`, which do not exist). `EXPIRED` stays unwritten until something writes `validUntil` (§5 — nothing does today; CERTIFICATION is 30.8's evidence type). Declaring all four now and lighting up one is consistent with 30.1's own precedent (the enum shipped a full turn before any value but `ACTIVE` had a writer).

| State | Meaning | Who transitions into it | Allowed previous | Allowed next | Contributes | Affects confidence | Visible | In history |
|---|---|---|---|---|---|---|---|---|
| ACTIVE | In force. | System, on evidence creation (only entry point today). Also the target of `reinstate`. | (initial), REVOKED | REVOKED (30.3), EXPIRED (30.8+cron), SUPERSEDED (30.8) | Yes (subject to `verificationStatus`/`validUntil`) | Yes | Yes | Yes |
| REVOKED | Administratively withdrawn — an integrity correction, not a trust judgment. | ORG_ADMIN, SUPER_ADMIN, reason required (30.3 — new). | ACTIVE | ACTIVE (`reinstate`) | No | No | Yes, with reason | Yes |
| EXPIRED | Past its own `validUntil`. | System (cron), once a `validUntil`-bearing evidence type exists. | ACTIVE | — (terminal; no un-expire — see §5) | No | No | Yes | Yes |
| SUPERSEDED | Replaced by a newer assessed-level assertion for the same learner/skill. | System, same transaction as the new assessed-level row (30.8). | ACTIVE | — (terminal) | No | No | Yes | Yes |

No fifth state is justified. A tempting fifth, `PENDING_REVIEW`, was considered (mirroring `EvidenceVerificationStatus.PENDING`) and rejected: it would duplicate an axis that already exists (verification trust) rather than adding a state-axis concept, which is exactly the "verification vs. assessment" collapse §11 must avoid.

**Terminal states:** `EXPIRED` and `SUPERSEDED` are terminal by design — matches contract §13's existing table (expiry and supersession are not reversed; a new certification or a new assessment is a *new* row, not an un-expiry of the old one). `REVOKED` is the only state with a documented way back (`reinstate`), because it is the only state-axis transition invented *for* the purpose of later correction (an admin fixing their own or another admin's mistake).

---

## 4. Validity semantics

**Unchanged from contract §B2/proficiencyPolicy.ts, and already correctly implemented.** Restated as the frozen definition 30.3 must not silently drift from:

```
valid(e, asOf) := e.state === "ACTIVE"
                  AND e.verificationStatus !== "REJECTED"
                  AND (e.validUntil === null OR e.validUntil > asOf)
                  [AND caller's query already scopes tenantId — not checked inside isEvidenceValid]
```

`state` is not a hidden substitute for validity — it is one of validity's three independent inputs (state, verification, expiry), each auditable and readable separately (contract §4's own framing, confirmed correct by the current code's separation of `state` and `verificationStatus` into two columns that `isEvidenceValid` ANDs together, never collapses).

One clarification the current code makes that the contract text doesn't spell out: **`isEvidenceValid` takes no `tenantId` parameter at all** — it is a pure function over `{verificationStatus, state, validUntil}` only. Tenant consistency (contract B2's fourth clause) is enforced entirely by every caller's query already being tenant-scoped (`WHERE tenantId = ...`), never by a check inside the validity predicate itself. This is correct and matches V1's own posture, but it means a 30.3 implementer must not assume `isEvidenceValid` is tenant-safe in isolation — it is only as safe as its caller's query.

---

## 5. `validUntil`

**Nothing writes it today. This changes the shape of 30.3's work for this field: there is no expiry to implement yet, only the machinery that will matter once something does.**

Decisions, restated precisely:

- **Nullable semantics:** `null` = "does not expire" (correct default for every current production evidence type — none has an expiry concept). A set value is a hard boundary: `validUntil <= asOf` invalidates.
- **Timezone semantics:** `DateTime` in Postgres/Prisma is stored UTC; all comparisons (`isFresh`, `isEvidenceValid`) use `Date` object comparison, which is timezone-agnostic by construction (both sides reduce to epoch milliseconds). No new timezone handling is needed.
- **Boundary at exact expiry:** `isEvidenceValid` uses `validUntil <= asOf` (strict) — at the exact instant `validUntil` equals `asOf`, evidence is already invalid, not valid-through-that-instant. `isFresh` uses `validUntil > asOf` (also strict) for the same instant, so the two predicates agree at the boundary (both say "not fresh/not valid" at exactly `validUntil`). **[verified this session: `proficiencyPolicy.ts:67`, `proficiencyPolicy.ts:130`]**. This is the frozen boundary rule; 30.3 must not change it without a test proving the new boundary at both predicates.
- **Evaluated dynamically or materialized?** Both, in different senses: `isEvidenceValid`/`isFresh` evaluate dynamically against whatever `asOf` the caller supplies (correct for every *read*, including a fresh `projectUserSkill` call, which always passes `now`). But `UserSkill.proficiency`/`evidenceConfidence` are **caches** — they are correct only as of the last recompute, per contract A2. An expiry that happens with no new write (nothing else changes about the evidence row except time passing) does not itself trigger a recompute. This is the same "cached projection can go stale" problem the discovery already named for time-driven validity (§8.2) — and it is unresolved by anything 30.1/30.2 built, because nothing writes `validUntil` yet to expose it.
- **Does expiry cause recomputation immediately or lazily?** **Recommendation: lazily, and only once a `validUntil`-writing evidence type actually ships (30.8).** Building the expiry cron now (task §5's own instruction: "Do not implement a cron merely to maintain an EXPIRED state unless the contract actually requires it") would run daily against zero eligible rows — pure ceremony, exactly what the task warns against. **This reverses D6's original "approve now" framing**: D6 is re-scoped in §29/§34 below to "approved in principle, built when `validUntil` gets its first writer," not built in 30.3.
- **Does expiry generate a proficiency event?** Yes, when it eventually runs: `EVIDENCE_EXPIRED` already exists in `ProficiencyEventCause` (30.1's schema, unused). The cron's per-row transaction would set `state = EXPIRED`, then call `projectUserSkill` with `cause: "EVIDENCE_EXPIRED"`, in the same transaction — the existing `projectUserSkill` shape already supports this without modification, since `cause` is already a caller-supplied parameter.

---

## 6. Freshness vs. hard expiry — and the staleness gap 30.2 leaves open

The discovery's `validUntil` vs. 365-day-freshness distinction is implemented exactly as specified (§4, §5 above). One consequence neither prior phase resolved, found by tracing `confidenceFor`'s only caller. **A second, separate concern feeds the same `occurredAt` this section discusses: §1's confirmed backfill cross-contamination bug (D24) means some already-backfilled rows' `occurredAt` is not just stale but factually wrong (another learner's timestamp) — freshness computed from a wrong `occurredAt` is wrong regardless of how the staleness question below is resolved.**

**`UserSkill.evidenceConfidence` is written only when a real transaction recomputes the row.** A row that reaches HIGH confidence today (fresh + VERIFIED) stays stamped `HIGH` forever unless something writes to it again — there is no periodic refresh, and (per §5) no cron exists to force one. A learner whose only supporting evidence crosses the 365-day freshness boundary sees no change in `evidenceConfidence` until *any* unrelated evidence event on that skill happens to trigger a fresh recompute.

**Decision, matching the smallest-durable-model principle: accept this as a documented limitation for 30.3, not a defect to fix with a job.** Reasoning:
- A confidence-only staleness lag has no correctness consequence for `proficiency` or role readiness (`MET`/`BELOW`/`MISSING` are unaffected by confidence — contract D4).
- The alternative (a periodic confidence-refresh job) is exactly the "confidence refresh job" the task's own §30 explicitly requires justifying, not assuming. No product surface built yet reads `evidenceConfidence` — **[verified this session: `grep -rln "evidenceConfidence" src/app src/components` returns zero matches]** — so there is no user-visible harm to measure against the cost of a new scheduled job.
- If a future phase's UI shows confidence prominently, the fix is bounded and cheap then: a nightly per-tenant `reconcileTenant`-shaped pass that recomputes only `evidenceConfidence`/`policyVersion` (never `proficiency`) for rows whose supporting evidence has crossed the freshness boundary since the cache was written. Not built now.

**A second, load-bearing correctness question found by testing `confidenceFor` against Policy 1's own ceiling table (not previously stated in the contract):** because `supporting` is defined as "evidence whose `ceilingFor` equals the *projected level*" (contract D2), and Policy 1's `ceilingFor` only ever returns `NONE`, `BEGINNER`, or `INTERMEDIATE`:

```
level = INTERMEDIATE  →  supporting is entirely VERIFIED rows  →  confidence ∈ {HIGH, MEDIUM}, never LOW
level = BEGINNER      →  supporting is entirely non-VERIFIED rows (UNVERIFIED/PENDING) →  confidence ∈ {MEDIUM, LOW}, never HIGH
level = NONE           →  confidence is always null
```

This is not a bug — it follows correctly from `confidenceFor`'s own definition once Policy 1's two-value grant table is substituted in — but it means **under Policy 1, `HIGH` and `LOW` are each reachable from only one proficiency level.** This should be locked as an explicit invariant/test in 30.3 (it is not asserted anywhere today), because it is exactly the kind of implicit consequence that would silently break the moment a type-aware grant table changes what `ceilingFor` can return for a given verification status.

**Freshness, made fully explicit — every boundary condition the task's §7 asks for, none left implicit, re-read directly from `proficiencyPolicy.ts:126-133` this session:**

| Question | Answer |
|---|---|
| Reference timestamp | The recompute's own `now` (`asOf`, passed by the caller — `projectUserSkill` always passes `new Date()` taken at recompute time), **never** the caller's possibly-backdated `changeTimestamp` |
| `occurredAt` or `createdAt`? | `occurredAt` only — `isFresh` never reads `createdAt` |
| Window | A fixed constant, `CONFIDENCE_FRESHNESS_WINDOW_DAYS = 365`, converted to milliseconds (`365 * 24 * 60 * 60 * 1000`) — calendar-agnostic, not "365 calendar days" with month/leap-year variance |
| Boundary at exactly 365 days | Fresh (`<=` — `proficiencyPolicy.ts:132`, `asOf.getTime() - occurredAt.getTime() <= FRESHNESS_WINDOW_MS`) |
| Missing `occurredAt` | Not fresh (`:131`, explicit `null` check returns `false`) — "unknown" is never treated as "recent" |
| Future-dated `occurredAt` | **Currently fresh** — a negative age (`asOf - occurredAt < 0`) satisfies `<= FRESHNESS_WINDOW_MS` trivially. **Decision: accept this, not clamp it, for 30.3.** A future `occurredAt` can only arise from a caller passing a bad `changeTimestamp` into evidence creation (not from user input — no evidence writer accepts a client-supplied `occurredAt`), so this is a defensive-programming question, not a security one; clamping would add a branch with no reachable trigger today. Revisit only if a future evidence source ever accepts a caller-supplied `occurredAt`. |
| `validUntil` set, in the future | Fresh **regardless of `occurredAt`'s age** — checked first, before the `occurredAt` branch (§8) |

**When does `CURRENT_POLICY_VERSION` bump, precisely — not previously stated anywhere, needed before 30.3 writes its first line:** the constant (`proficiencyPolicy.ts:29`, currently `1`) versions **the grant table** (`ceilingFor`), not the module as a whole. **30.3 does not bump it** — everything this phase changes (validity/state transitions, verification authority, the audit table, confidence's existing rule) sits outside `ceilingFor` itself; Policy 1's grant table is explicitly kept unchanged through 30.3 (§32, D19). The version bumps only when one of these three actually changes: (1) `ceilingFor`'s grant table (the type-aware Policy 2, deferred to 30.8), (2) `isEvidenceValid`'s validity predicate, or (3) `confidenceFor`'s rule tree. A change to *authorization* (who may transition what) or to the *audit* table is not a policy change and must not bump the version — `policyVersion` answers "what would this evidence set project to," not "who was allowed to touch it."

---

## 7. Confidence semantics

Already correctly bounded by contract §D1/§D3/§D4 and the implementation. Restated as the frozen definition:

> Confidence answers "how strongly should Lumio trust/present the evidence supporting the *current* capability state" — never "what level does the learner have." It is derived, categorical, cached, and **never** an input to `proficiency`, never settable by any request, admin, or AI (contract D3 — re-confirmed: `grep -rn "evidenceConfidence\s*:" src --include="*.ts"` outside `/generated/` finds writes only inside `proficiency.ts` and `capabilityBackfill.ts`, both computed from `confidenceFor`, never from a request body).

Nothing in 30.3's scope changes this boundary. The only open item is the staleness question in §6.

---

## 8. Confidence calculation

Implemented exactly as contract §D2 specifies (`proficiencyPolicy.ts:154-175`), re-verified this session line-by-line:

```
supporting = validEvidence.filter(e => ceilingFor(e) === level)
if level === NONE: return null
if supporting.length === 0: return null
if supporting.some(VERIFIED && fresh): return HIGH
if supporting.some(VERIFIED) || distinct-unverified-types(supporting) >= 2: return MEDIUM
else: return LOW
```

No numeric weighting exists or is proposed. No dimension beyond the four the discovery named (verification status, source-type count for corroboration, freshness, validity via the `validEvidence` prefilter) is used — `assessor identity`/`assessment quality`/`consistency between sources` (task §9's broader list) are **explicitly not built**, matching the discovery's own rejection of arbitrary weighted scoring. This is unchanged from 30.1/30.2; nothing about 30.3's own scope (verification-transition semantics, revoke, source invalidation) requires touching `confidenceFor`'s rule tree itself — only §6's staleness question and the caveat below bear on it.

**One boundary worth stating precisely, not previously called out**: `isFresh` treats a `validUntil` set in the future as fresh **regardless of `occurredAt`'s age** (`proficiencyPolicy.ts:130`, checked before the `occurredAt` branch). A five-year-old CERTIFICATION with a `validUntil` two years out reads as fresh (and can support `HIGH`) even though the underlying assessment is old. This is a deliberate design choice, not an oversight — it matches the product intent that an explicit expiry *is* the trust signal for that evidence class (a still-valid certification is still trusted, by construction of what a certification means), while course/quiz/assignment evidence (which never sets `validUntil`) falls through to the `occurredAt`-based freshness window. **Locked as an explicit rule for 30.3, since it becomes reachable the moment CERTIFICATION evidence exists (30.8):** `validUntil` in the future always means fresh, independent of `occurredAt`.

---

## 9. Confidence aggregation

Already implemented and correct: contract §D2's rule ("supporting has a VERIFIED-or-assessed row that is fresh → HIGH; ... OR supporting has UNVERIFIED rows of ≥2 distinct evidence types → MEDIUM") is a **deterministic rule hierarchy**, not a weighted average, not order-dependent (it is computed by filtering and set-cardinality over the full `supporting` array, never a fold that could depend on iteration order), and safe under duplicate/retried evidence (the `[tenantId, userId, skillId, sourceType, sourceId]` uniqueness that already governs evidence creation means "duplicate evidence" cannot occur as distinct rows in the first place — see §14).

Corroboration counts **distinct evidence types**, never raw source/evidence-row ids — this is what keeps legacy per-attempt `"QuizAttempt"`-sourced rows (Phase 25's historical shape) from inflating MEDIUM confidence the way counting raw ids would. Confirmed unchanged and correct.

No further aggregation rule (strongest/weakest/majority/source-weighted) is needed or proposed — the existing rule already resolves multiple evidence rows deterministically via the `supporting` filter plus the two boolean/count checks.

---

## 10. Verification semantics

**Current contract, re-verified against the code this session (unchanged since Phase 5/20, plus the one `revision` field):**

| Question | Answer | Evidence |
|---|---|---|
| Who can verify | Course-owning INSTRUCTOR; SUPER_ADMIN — **but SUPER_ADMIN is tenant-bound too** (see correction below) | `verification.ts:146-174` |
| Who can reject | Same set | same |
| Can the learner verify own evidence | Never, any role | `verification.ts:150-152`, checked first, before tenant/source resolution |
| Does verification require source resolution | Yes, for **every** actor including SUPER_ADMIN | `verification.ts:157-165` |
| Does rejection require source resolution | Yes — **same function, same precondition, for both `verify` and `reject`** (contract E4 proposes decoupling this; not yet done) | `setEvidenceVerificationStatus` calls `authorizeVerificationActor` identically for both |
| Is verification idempotent | **No.** A second verify by any authorized actor overwrites `verifiedById`/`verifiedAt` unconditionally. No precondition reads the current `verificationStatus` before writing. | `verification.ts:202-213` — the `data:` object is built directly from `status`, no branch on current state |
| Does ORG_ADMIN have any verification authority | No — excluded by the role check (`actor.role !== "INSTRUCTOR"` throws, except SUPER_ADMIN) | `verification.ts:168-170` |

**Correction to the discovery/pre-flight's own stated SUPER_ADMIN authority, found by re-reading this session, not merely inherited:** `authorizeVerificationActor` checks `evidence.tenantId !== actor.tenantId` **before** the role branch, with no exception for SUPER_ADMIN (`verification.ts:153-155`). The pre-flight's own audit table (§10) stated "SUPER_ADMIN: Any tenant's evidence, source must still resolve" — **this is not what the code does.** SUPER_ADMIN today can only verify/reject evidence in the tenant context `actor.tenantId` already carries (presumably a tenant the SUPER_ADMIN has selected/impersonated, per this repo's existing multi-tenant auth pattern — `AuthContext & {tenantId: string}` is the same shape every other tenant-scoped call uses). **This is not a defect to fix — it is more conservative than what was documented, and no SUPER_ADMIN-scoped capability route exists anyway** — **[verified this session: `grep -rln "SUPER_ADMIN" src/app/api/org src/app/api/instructor` matches only `*.route.test.ts` files (test fixtures asserting SUPER_ADMIN is denied/excluded); zero production `route.ts` files reference it]** — so it is moot in practice. Recorded here so 30.3 does not "fix" a discrepancy that is actually the discovery documents being wrong, not the code.

---

## 11. Verifier independence

Unchanged, and already exactly what the contract requires (§12.2 "Subject-independence: never the subject"):

- **Learner-created evidence:** there is no learner-created evidence path — every evidence type with a production writer (`COURSE_COMPLETION`, `QUIZ_SCORE`, `ASSESSMENT`) is created by a trusted system outcome, never directly by the learner. The independence rule therefore applies to *verification*, not creation: the learner who the evidence is *about* can never verify or reject it (`verification.ts:150-152`), full stop, regardless of role.
- **Instructor-created evidence:** n/a — instructors never create evidence directly either (only grade submissions, which *then* triggers system-generated ASSESSMENT evidence).
- **System-generated course/quiz evidence:** verified by the course-owning instructor or SUPER_ADMIN — never self-verified because the system, not a person, created it.
- **Assessor evidence (30.8, not yet built):** the person asserting `assessedLevel` **is** the verifier by construction (contract C7 — "created VERIFIED"). §12.3's recommendation (verify/reject/unverify must refuse to act on `MANAGER_ASSESSMENT`/`CERTIFICATION` rows once they exist) is reaffirmed here as a 30.8 requirement, not implemented now since those types have no writer.

---

## 12. Rejection semantics

| Question | Current answer |
|---|---|
| Does rejected evidence remain permanently rejected | **Yes, today** — no `reopen` action exists. `REJECTED → VERIFIED` is technically permitted by the code (no precondition blocks it — see §14) but has no product-level "undo" concept; a second `verify` call would silently succeed and overwrite the rejection with no record of why it was reversed. |
| Can it later be corrected | Only by a raw re-verify, which is the idempotency gap in §14, not a designed correction path. |
| Does rejection invalidate the evidence | Yes — `verificationStatus === "REJECTED"` is one of `isEvidenceValid`'s three ANDed conditions. |
| Does it stop contribution immediately | Yes, in the same transaction as the write (`projectUserSkill` runs inside `setEvidenceVerificationStatus`'s `$transaction`). |
| Does rejection trigger `UserSkill` recomputation | Yes, always (the recompute call is unconditional in `setEvidenceVerificationStatus`; whether it produces an *event* depends on whether the level actually changed — §1). |
| Does rejection create a `SkillProficiencyEvent` | Only if the level changed. If the learner has a second VERIFIED row for the same skill, rejecting an already-non-contributing REJECTED-adjacent row (or one that isn't the sole support) produces **no** event today — a genuine, real audit gap (see §26). |
| Does rejection require a reason | No — `reason` is an optional field on `SkillProficiencyEvent` but nothing in `verification.ts` accepts or forwards one; the API's `bodySchema` (`z.object({action: z.enum(["verify","reject"])})`) has no `reason` field at all. |
| Can the actor who verified also reject | Yes, no restriction — same authorization predicate for both actions. |
| Can ORG_ADMIN reject | **No, today.** Contract D3 proposes granting this; not built. |
| Can rejection happen after assessment | n/a — assessed-level evidence does not exist yet (30.8). |

---

## 13. Revocation semantics

**Does not exist today in any form.** This section specifies what 30.3 should build, distinct from rejection along the axis already reserved in the schema (`state`, not `verificationStatus`):

```
REJECTED  → a human judged this evidence does not demonstrate the skill (a trust judgment, on the verification axis)
REVOKED   → this evidence is no longer in force for an administrative/integrity reason,
            independent of whether it was ever trusted (the state axis)
```

**Is the distinction useful for Lumio, concretely?** Yes — one real scenario the pre-flight already found live in this codebase's own data makes it concrete: evidence created from a data-entry error, a duplicate CourseSkill mapping later found wrong, or (once course completion revocation exists, §14) a refunded enrollment, is not a case where "the instructor doesn't believe this demonstrates the skill" (that's rejection) — it's a case where "this row should not have existed as evidence, regardless of what it demonstrates." Collapsing the two into one action would force every administrative correction to also destroy the VERIFIED standing (so a later, legitimate re-verification would be needed even though nothing about trust changed) — `reinstate` exists specifically to avoid that.

**Definition, kept on the state axis only — never touching `verificationStatus`:**

| Field | Value |
|---|---|
| Actor | ORG_ADMIN, SUPER_ADMIN (tenant-bound, matching §10's existing pattern) |
| Reason | **Required** — a new, non-optional field on the action (the API and the domain function both reject an empty/missing reason) |
| Authorization | Same tenant-match rule as `verifyEvidence`; **no source-resolution requirement** (contract E4 — a revoke must work even when the underlying course/quiz/assignment can no longer be resolved, since "the source disappeared" is itself one of the scenarios revoke exists for) |
| Timestamp | `recordedAt` on the new audit row (§26) is always server time, `now()` at the moment the transaction commits — **no client-supplied `occurredAt` override.** `revoke`/`reinstate` are an ORG_ADMIN/SUPER_ADMIN correction action, not a business-time-backdated fact the way `Enrollment.completedAt` is; accepting a caller-supplied timestamp here would let an admin claim a correction happened earlier than it did, with no product reason to allow that. (This differs from `SkillProficiencyEvent.occurredAt`, which *does* accept backdating from trusted system outcomes like `Enrollment.completedAt` — that distinction is deliberate: system-derived business time is trusted, admin-supplied business time is not.) |
| Effect on proficiency | `state = REVOKED` excludes the row from `isEvidenceValid`, so a recompute (same transaction) may lower the level, exactly like rejection |
| Effect on confidence | Same mechanism — the row drops out of `supporting` |
| History event | `SkillProficiencyEvent` with `cause: "EVIDENCE_REVOKED"` if the level changed (§22); the audit row (§26) is written unconditionally, level-change or not |
| Reversible | Yes — `reinstate` (`state = ACTIVE`), same actor set, reason required, restores `verificationStatus` to whatever it already was (never re-verifies) |

---

## 14. A structural gap found this session: verification's check-then-write is not transactional, and re-verify is not idempotent

Not previously stated as precisely as it should be. Tracing `setEvidenceVerificationStatus` (`verification.ts:183-227`) end to end:

1. `db.skillEvidence.findUnique` — **outside any transaction.**
2. `authorizeVerificationActor(actor, evidence)` — reads the fetched row's fields (`userId`, `tenantId`, `sourceType`, `sourceId`), also outside a transaction, including an `await resolveSourceCourse(...)` DB round trip.
3. `db.$transaction(async (tx) => { tx.skillEvidence.update(...); projectUserSkill(tx, ...) })` — the only transactional part, and it **re-reads nothing**: it blindly writes `verificationStatus`/`revision` based on the `status` argument, with no `WHERE revision = expectedRevision` guard and no re-check of the row's current standing.

**Consequences — the concurrency scenario is [derived] from reading the code's structure, not reproduced by an actual race this session (no test was run to force it); the single-actor sequential consequence is [code], directly observable from the current implementation without any concurrency:**
- **[derived]** Two concurrent `reject` calls on the same evidence row both succeed, both increment `revision`, and (because `projectUserSkill`'s own lock only serializes the `UserSkill` row, not the `SkillEvidence` row) the second one's event has a real, distinct `evidenceRevision` — no data corruption, but no CAS protection either: a stale-precondition write (e.g., 30.3's future `verify` explicitly refusing to act on a `REVOKED` row) cannot be enforced correctly by a check performed before the transaction opens, because the row can change between the check and the write. This follows directly from the code's own structure (fetch outside the transaction, no `WHERE revision = expected` guard) the same way 30.0's pre-flight audit derived the `UserSkill` lost-update race (G2) without reproducing it — correct by construction of the code, not requiring a live race to confirm.
- **[code]** Re-verifying an already-VERIFIED row is not a no-op, with no concurrency required to observe it — a single actor calling `verifyEvidence` twice in sequence re-writes `verifiedById`/`verifiedAt` to the new call's actor and increments `revision`, because `setEvidenceVerificationStatus` never reads the row's current `verificationStatus` before writing (`verification.ts:202-213`).

**Fix required for 30.3 (not implemented in this discovery pass, specified for the next slice):**
- Move the evidence fetch **inside** the transaction, as `SELECT ... FOR UPDATE` on the `SkillEvidence` row — mirroring the exact pattern `proficiency.ts` already uses for `UserSkill` (contract F1's own locking convention, applied one level up).
- **Lock order, fixed and documented:** `SkillEvidence` row first, then `UserSkill` row (via `projectUserSkill`, called from inside the same transaction) — never the reverse, to avoid a future deadlock between a verification transaction and a concurrent evidence-creation transaction that might otherwise lock the two rows in opposite order. (`outcomes.ts`'s creation path only ever touches one `SkillEvidence` row it just created plus the `UserSkill` row — no ordering conflict exists there today, but the rule should be stated once, here, for every future writer to follow.)
- Re-check the row's current `verificationStatus`/`state` **inside** the lock, before applying the transition, against the transition table in §15.
- **Idempotent re-verify (contract D10, still correct as a target):** `VERIFIED → VERIFIED` (re-verify) is a no-op that changes nothing — not `verifiedById`, not `verifiedAt`, not `revision` — and returns the current `UserSkill` unchanged. This requires the lock-and-check above to detect "already at this state" before writing, not the current "always write" behavior.

---

## 15. Re-verification — transition table

Every transition from the task's own list, decided (not every one is allowed):

| From → To | Allowed? | Actor | Effect |
|---|---|---|---|
| UNVERIFIED → VERIFIED | Yes (V1) | verify set | Level may rise one step; audit row + possible proficiency event |
| VERIFIED → VERIFIED | Yes — **idempotent no-op (D10)** | verify set | Nothing changes; first verifier preserved; no audit row (nothing happened) |
| VERIFIED → REJECTED | Yes (V1) | verify set + ORG_ADMIN (D3) | Level may fall; `verifiedById` is **kept, not cleared** — see note below |
| REJECTED → VERIFIED | Yes (V1, unintentionally — see §14) | verify set | Treated as a normal verify; audit row records the actual prior state (REJECTED), so the transition is explainable even though the *action* is the ordinary `verify` |
| REJECTED → REJECTED | Yes — **idempotent no-op (new, symmetric with D10)** | verify set + ORG_ADMIN | Nothing changes |
| REVOKED → VERIFIED | **No — refused.** | n/a | `state !== ACTIVE` is checked before any verification-axis transition is attempted; refused with a distinct error (`CapabilityVerificationError`-shaped, a new 409-equivalent case, not 403/404) telling the actor to `reinstate` first |
| EXPIRED → VERIFIED | **No — refused**, same reason as REVOKED | n/a | Same distinct error |
| SUPERSEDED → VERIFIED | **No — refused**, same reason | n/a | Same distinct error |

**One unified `verifiedById`/`verifiedAt` rule across every transition — not previously stated, and the task's own §13 requires exactly one:** an earlier pass of this document had `reject`/`reopen` leave the fields untouched while `unverify` cleared them — inconsistent, because `reject`→`reopen` and `unverify` both land the row on a non-VERIFIED status (`REJECTED` then `UNVERIFIED`, or `UNVERIFIED` directly) yet would disagree on whether a stale verifier name survives. **Decision: `verifiedById`/`verifiedAt` are never cleared by any transition, including `unverify`.** They mean, and have only ever meant since Phase 5, "the actor and time of the most recent `verify` action" — a **legacy, display-only** field, never a live "is this currently trusted" signal (that question is answered by `verificationStatus` alone). This matches current, unmodified behavior exactly (the pre-flight's 489-row finding — REJECTED rows with a stale `verifiedById` — is not a bug to "fix" by clearing anything) and removes the inconsistency by never introducing an exception. **The authoritative, complete history of who did what and when — including every `unverify`/`revoke`/`reinstate` actor — lives only in the new `EvidenceStandingEvent` table (§26); `verifiedById`/`verifiedAt` are not, and were never, that record.** This also **supersedes** the task's own §13/discovery §12.1 proposal to clear them on `unverify` — recorded as a deliberate deviation, not an oversight, since a mutable single-actor field cannot correctly represent a repeatedly-transitioned row's full history anyway; only the append-only table can.

**`unverify` (VERIFIED → UNVERIFIED), new for 30.3:**

| From → To | Allowed? | Actor | Effect |
|---|---|---|---|
| VERIFIED → UNVERIFIED | Yes (new) | verify set + ORG_ADMIN (D3) | `verifiedById`/`verifiedAt` left untouched (see rule above); level may fall one step; audit row records the actor who unverified — the authoritative record of this specific action (§26) |

**A general precondition rule covering every `(current standing, action)` pair — not just the "→ VERIFIED" cases above, which the task's own transition-table request (§14) and an implementer would otherwise have to invent for combinations like "reject a REVOKED row" or "reinstate an already-ACTIVE row":**

```
For any action A with declared source-state set S(A) and target T(A):
  if A is a verification-axis action AND evidence.state != ACTIVE:
                                                   refuse — 409, "reinstate first" — checked BEFORE the
                                                   no-op check below, so a VERIFIED-but-REVOKED row's
                                                   `verify` is never silently treated as a no-op
  else if current state/status already equals T(A):  no-op — no revision bump, no audit row (nothing happened)
  else if current state/status is in S(A):        apply — revision bumps, audit row written, recompute runs
  else:                                            refuse — 409-equivalent CapabilityVerificationError,
                                                    naming the actual current state/status
```

The ordering matters concretely: a `VERIFIED` row that gets `revoke`d keeps `verificationStatus = VERIFIED` (revoke only touches `state`, §13). A later `verify` call on it must not read "status already equals VERIFIED" and short-circuit to a no-op — the `state != ACTIVE` check runs first and refuses with the same "reinstate first" error §15's table already specifies for `REVOKED → VERIFIED`, regardless of what `verificationStatus` happens to hold underneath. State-axis actions (`revoke`/`reinstate`) have no such precheck — they only ever look at `state` itself.

Per-action `S(A)` (verification-axis actions require `state = ACTIVE`, unchanged from §10's existing rule — none of them can apply to a REVOKED/EXPIRED/SUPERSEDED row until `reinstate` restores `ACTIVE` first):

| Action | Axis | Source-state set `S(A)` | Target `T(A)` |
|---|---|---|---|
| verify | verification, requires `state = ACTIVE` | UNVERIFIED, PENDING, REJECTED | VERIFIED |
| reject | verification, requires `state = ACTIVE` | UNVERIFIED, PENDING, VERIFIED | REJECTED |
| unverify | verification, requires `state = ACTIVE` | VERIFIED | UNVERIFIED |
| reopen | verification, requires `state = ACTIVE` | REJECTED | UNVERIFIED |
| revoke | state (no source-resolution requirement, §25) | ACTIVE | REVOKED |
| reinstate | state (no source-resolution requirement, §25) | REVOKED | ACTIVE |

Worked examples the table above didn't spell out: `reject` on an already-`REJECTED` row is the no-op branch (matches §15's `REJECTED → REJECTED` row exactly). `unverify` on an already-`UNVERIFIED` row is the same no-op branch (not previously stated — `UNVERIFIED` is `T(unverify)`, so this falls out of the general rule for free, no separate row needed). `reopen` on a `VERIFIED` row is the refuse branch (`VERIFIED ∉ S(reopen) = {REJECTED}`). `revoke` on an already-`REVOKED` row is the no-op branch. `reject`/`unverify`/`reopen` attempted on any non-`ACTIVE`-state row (REVOKED/EXPIRED/SUPERSEDED) is the refuse branch, same distinct error as §15's `REVOKED → VERIFIED` row, telling the actor to `reinstate` first — this generalizes what §15 stated only for `verify` to every verification-axis action.

---

## 16. Source invalidation and revocation

Trace of every source, re-verified against the schema and route files this session (table form per the task's own request):

| Source | Can disappear? | Can be revoked? | Evidence detects it? | Required 30.3 behavior |
|---|---|---|---|---|
| Course completion (Enrollment) | No production path sets `COMPLETED → REFUNDED` — **[verified this session: `grep -rn 'status: "REFUNDED"' src --include="*.ts"` outside tests returns zero writers]**. `Course` itself is never hard-deleted (`Enrollment.courseId` is `ON DELETE RESTRICT` — see §1 — so a course with any enrollment cannot be hard-deleted at all). | Not automatically — no signal exists. | No. | `revoke`, manual, ORG_ADMIN/SUPER_ADMIN, reason required. Cannot be automated without a new `Enrollment` state transition this phase does not add (out of scope). |
| Quiz (QuizAttempt) | `QuizAttempt` rows are immutable (no update route). **`Quiz`/`QuizAttempt` CAN be deleted today** — see the live path below. | Not automatically; the delete below is silent. | No — `SkillEvidence.sourceId` is a free string, not a real FK; a deleted `QuizAttempt`/`Quiz` leaves it dangling with no signal. | `revoke` (manual) covers correcting the resulting orphaned evidence after the fact. Making lesson-deletion itself refuse when evidence exists is a course-authoring change, out of this phase's scope — noted as a real, live gap, not fixed here. |
| Assignment (AssignmentSubmission) | A regrade never changes existing evidence (`outcomes.test.ts:793`, unchanged). **`Assignment`/`AssignmentSubmission` CAN be deleted today** — same live path as Quiz, below. | Not automatically; silent, same as Quiz. | No, same reason. | Same as Quiz: `revoke` covers the aftermath; the delete route itself is unchanged in this phase. |
| Assessed-level (30.8, not built) | N/A — points at no external source. | Yes, automatically, by design: a later assessment supersedes the earlier one in the same transaction (contract C7). | Yes, structurally. | `state = SUPERSEDED`, when 30.8 ships. |
| CERTIFICATION with `validUntil` (30.8, not built) | N/A | Detectable by time alone. | Yes, via the (deferred) expiry cron, §5. | `state = EXPIRED`, when 30.8 ships and the cron has a reason to run. |

**A live, reachable source-deletion path exists today — found this session by reading the delete routes, not assumed from "no app route deletes X":** `DELETE /api/courses/[courseId]/sections/[sectionId]/lessons/[lessonId]` (`route.ts:122-147`) and the sibling section-delete route call `db.lesson.delete`/`db.section.delete` directly, with **only an ownership check — no precondition on existing `QuizAttempt`/`AssignmentSubmission` rows.** The FK chain confirms the consequence: `Lesson → Quiz`/`Lesson → Assignment` are `ON DELETE CASCADE` (`migration.sql:441,459`), and — critically — `QuizAttempt.quizId`/`AssignmentSubmission.assignmentId` were changed from `RESTRICT` to **`ON DELETE CASCADE`** by `20260630175327_lesson_archive_cascade_fixes` (`migration.sql:20,26`, read directly this session). **An instructor deleting their own lesson today silently deletes every `QuizAttempt`/`AssignmentSubmission` row for it, orphaning any `SkillEvidence` whose `sourceId` pointed at one — no signal, no revocation, no event.** This is the concrete, already-shipped instance of "source deleted," and it is the strongest real justification for `revoke` existing at all: without it, an admin who later notices a learner's INTERMEDIATE proficiency rests on evidence from a deleted lesson has no way to correct it (the evidence is still `ACTIVE`/valid by every predicate — nothing detects the orphaning).

**Why none of the three activity types can be *automatically* invalidated (as opposed to manually revoked) even once detected, stated precisely:** none of `Enrollment`/`QuizAttempt`/`AssignmentSubmission` has an "this outcome is no longer valid" concept in the schema one layer below `SkillEvidence` — `Enrollment.status` has `REFUNDED` as a value but nothing transitions a row into it from `COMPLETED`; `QuizAttempt`/`AssignmentSubmission` have no status field for this purpose at all, and by the time they're deleted (the lesson-delete path above) there is nothing left to read a status from anyway. Building an automatic detector (e.g., a reconciliation pass that flags `SkillEvidence` rows whose `sourceId` no longer resolves) is a new integration outside Phase 30.3's evidence-standing scope — `revoke` (manual, reason-required, §13) is therefore not a simplification, it is the only currently-buildable *correction* mechanism; detecting *when* to use it is a separate, deferred concern (a candidate for a future reconciliation-style job, not specified further here).

**Source belongs to a foreign or invalid tenant:** unchanged — `valid()`'s tenant consistency is enforced at the caller's query scope (§4), never inside the pure predicate; a mismatch is excluded from every capability computation by construction.

**Skill archived:** unchanged from V1 — `gaps.ts:27` already filters `skill.status === "ACTIVE"` for requirements; evidence and the `UserSkill` projection are retained and continue recomputing regardless (an un-archive is correct with no special handling).

**Learner soft-deleted (`deletedAt`):** re-checked this session — `verification.ts` has **no `deletedAt` check on the evidence's own learner today** (contract E6 proposes this; not yet enforced). This is a real gap: nothing currently stops an instructor from verifying/rejecting evidence belonging to a soft-deleted learner. **Recommended 30.3 fix:** add the check inside `authorizeVerificationActor`, refusing (403, indistinguishable from a normal authorization failure) when the evidence's `user.deletedAt` is set.

---

## 17. Course completion evidence

Preserved exactly, re-confirmed this session against `outcomes.ts:170-245` and `reconciliation.ts` (file untouched by either 30.1 or 30.2 per `git log`): completion → `CourseSkill` → `SkillEvidence`, idempotent on the unique key, reconciled on every completion request and on new-mapping backfill. `occurredAt` is now populated (30.2, `outcomes.ts:60`) from the live write's own `completedAt` parameter — no change needed for 30.3. Nothing in this phase's scope touches this path; it is listed here only to confirm it, per the task's own instruction not to break Phase 24's guarantee.

---

## 18. Quiz evidence

Preserved exactly (`outcomes.ts:352-459`, unchanged since Phase 25, re-confirmed this session): pass-only, one row per learner/quiz/skill (`sourceType: "Quiz"`), first-pass-wins on score, legacy `"QuizAttempt"`-keyed rows remain valid and are excluded from double-counting by `skillsWithLegacyQuizEvidence`. **Supersession does not apply to quiz evidence** — the discovery's own §17 table already states this ("Not applicable: quiz evidence is one row per quiz and skill and is never superseded"), re-confirmed correct: nothing in 30.3's scope changes this. No production writer for `EvidenceType.QUIZ_SCORE` sets `validUntil`; expiry is not applicable to quiz evidence either.

---

## 19. Assignment evidence

Two distinct things, both unchanged, both re-confirmed this session:

1. **`Assignment`/`AssignmentSubmission` grading** — `ASSESSMENT` evidence, any graded score qualifies (no pass mark exists on `Assignment`, confirmed again: `maxScore Int @default(100)` is the only score-related field, no `passingScore`). A regrade never touches existing evidence. Unchanged for 30.3 — decision D13 (score does not affect level; a pass mark is a later, separate schema change) still holds and is out of scope here.
2. **`LearningAssignment`** (an admin assigning a course) — confirmed again this session that no *production* code under `src/lib/domain/learning-assignment` calls `db.skillEvidence.*`; assignment state is still never evidence. **[verified this session, corrected from an earlier draft's overstated "zero hits":** `grep -rn "skillEvidence\." src/lib/domain/learning-assignment` actually returns two hits, both in test files — `assignments.cancel.test.ts:78` and `assignments.create.test.ts:118`, each asserting `db.skillEvidence.count(...) === 0` after a specific cancel/create scenario. These are real, if narrow, positive checks — not the "nothing exists" the earlier draft implied.] Neither test is framed as the general contract J1/INV17 invariant ("this module never writes `SkillEvidence`, under any action") — each covers one specific scenario. **Recommended for 30.3's testing contract (§31):** add one test framed explicitly as the J1/INV17 invariant, covering every `LearningAssignment` action (assign, cancel, reactivate), not just the two scenarios already incidentally covered.

---

## 20. Supersession

**Not scoped for 30.3.** Restated against the corrected factual premise from §1: `supersededById` is not a column that exists and needs wiring up — it is a column that does not exist yet. Supersession is entirely a property of assessed-level evidence (`MANAGER_ASSESSMENT`/`CERTIFICATION`), which has no writer until 30.8. Building the state-axis transition (`ACTIVE → SUPERSEDED`) with nothing that can ever trigger it would be exactly the "generic evidence version graph" the task's own §33 instructs challenging. **Decision: `SUPERSEDED` stays a declared-but-unwritten enum value through 30.3, lit up only when 30.8 ships alongside `assessedLevel`/`supersededById`.**

---

## 21. Proficiency recalculation triggers

Every state/standing change 30.3 introduces, against whether it recomputes proficiency, recomputes confidence, and writes a `SkillProficiencyEvent`:

| Change | Recompute proficiency? | Recompute confidence? | `SkillProficiencyEvent`? | New audit row (§26)? |
|---|---|---|---|---|
| verify (UNVERIFIED/REJECTED → VERIFIED) | Yes (same txn) | Yes (same txn) | Only if level changed | Always |
| verify (VERIFIED → VERIFIED, no-op) | No — skipped entirely once the lock-and-check (§14) detects no-op | No | No | **No** — nothing happened |
| reject | Yes | Yes | Only if level changed | Always |
| unverify | Yes | Yes | Only if level changed | Always |
| reopen (REJECTED → UNVERIFIED, new) | Yes | Yes | Only if level changed | Always |
| revoke | Yes | Yes | Only if level changed | Always, reason required |
| reinstate | Yes | Yes | Only if level changed | Always, reason required |
| expire (cron, deferred — §5) | Yes | Yes | Only if level changed | Always (system actor, `actorId: null`) |
| supersede (30.8, deferred) | Yes | Yes | Only if level changed | Always (system actor) |

**The load-bearing rule, restated because it is the thing most likely to be gotten wrong**: a confidence-only change (the level does not move) must never create a `SkillProficiencyEvent` — this was already decided and correctly implemented in 30.2 (§1) and is **not reopened here**. What 30.3 adds is the *second*, always-fires table (the audit row, §26) for exactly the cases where the proficiency-event table alone is not enough to answer "why."

---

## 22. Historical proficiency event semantics

`SkillProficiencyEvent`'s own shape (contract §F, 30.1's schema) is unchanged and sufficient for every *proficiency* cause 30.3 needs — `EVIDENCE_REJECTED`, `VERIFICATION_REVOKED` (mapped to `unverify`), `EVIDENCE_REOPENED`, `EVIDENCE_REVOKED`, `EVIDENCE_REINSTATED`, `EVIDENCE_EXPIRED`, `EVIDENCE_SUPERSEDED` all already exist in `ProficiencyEventCause` (30.1, unused until now). **No schema change is needed to `SkillProficiencyEvent` itself for 30.3.** The gap is entirely the audit-trail question in §26, which is a *different* table, not an extension of this one.

---

## 23. Confidence history

**Decision, unchanged from the discovery's own recommendation, re-confirmed against this session's findings: no.** Confidence stays current-state-only (`UserSkill.evidenceConfidence`, a cache). Nothing found this session changes the calculus — no analytics consumer exists yet (Phase 31 is unbuilt), and extending `SkillProficiencyEvent` to fire on every confidence-only transition was already rejected once (contract §24, "Do NOT automatically extend SkillProficiencyEvent to every confidence transition") for a sound reason that still holds: it would make "why did an event fire" ambiguous between "the level changed" and "confidence merely ticked," undermining the one rule §21 depends on being simple.

---

## 24. Authorization matrix

Traced against the actual code this session, distinguishing current (V1/30.2) from proposed (30.3):

| Action | STUDENT | INSTRUCTOR | ORG_ADMIN | SUPER_ADMIN |
|---|---|---|---|---|
| submit evidence | Indirect only (via a trusted outcome) | Indirect only (grading triggers it) | No path | No path |
| verify | **Never**, even own | Owned-course source only [current] | **No** [current & unchanged — see §10 rationale] | Own tenant only [current, corrected from prior docs] |
| reject | Never | Owned-course source only [current] | **Yes** [new, 30.3, D3] | Own tenant only |
| unverify | Never | Owned-course source only [new, 30.3] | **Yes** [new, 30.3, D3] | Own tenant only [new] |
| reopen | Never | Owned-course source only [new, 30.3] | No | Own tenant only [new] |
| revoke | Never | No [revoke is administrative, not verification-authority] | **Yes**, reason required [new, 30.3] | Own tenant only [new] |
| reinstate | Never | No | **Yes**, reason required [new, 30.3] | Own tenant only [new] |
| read own evidence | Yes, self only [current] | n/a (not the subject) | n/a | n/a |
| read others' evidence | No | Owned-course, shared-enrollment only [current] | Tenant-wide via reports only, never raw rows [current] | Not addressed by any route today [current, unchanged] |
| read history (once 30.4 ships read APIs) | Own only | Owned-evidence scope only (D16) | Not scoped here | Not scoped here |

**No manager role exists in the data model** (`Team`/`TeamMember` carry no role field — re-confirmed this session, `prisma/schema.prisma:417-444`). The task's own manager-facing questions (§11) are answered, as the discovery already concluded, by ORG_ADMIN and INSTRUCTOR — nothing invents a manager role here.

---

## 25. Tenant isolation

Every new transition in §13/§15/§21 above inherits the existing rule, re-confirmed still structurally sound this session: `evidence.tenantId !== actor.tenantId` throws, checked before any role-specific logic (`verification.ts:153-155`). Two additions this phase's transitions require, both already implied by the existing pattern, stated explicitly so a 30.3 implementer does not have to re-derive them:

- **`revoke`/`reinstate` must use the same tenant check, but must NOT additionally require source resolution** (§13 — this is the one place a lowering action's authorization diverges from `verify`/`reject`'s current shared precondition, contract E4).
- **§16's "source belongs to a foreign tenant" case**: unchanged — excluded by `valid()`'s query-scope enforcement, never inside the pure predicate (§4).

**Behavior when the source has disappeared but evidence remains** (task's own explicit question): the evidence still contributes if otherwise valid (§16) — its standing does not depend on the source resolving, only verification/authorization actions that need to *identify the course* (`verify`/`reject`, today) do. `revoke` is specifically designed not to need this (§13), which is what makes it the only lowering action guaranteed to work once a source is gone.

**Source resolution, per action — resolving a real contradiction between §13's revoke design and E4's blanket "lowering actions never require source resolution":** the current code requires source resolution for `verify` **and** `reject` identically (§10 — `setEvidenceVerificationStatus` calls the same `authorizeVerificationActor` for both), so applying E4 literally to `reject` (and the new `unverify`/`reopen`) would be a behavior change beyond this phase's evidence, not merely a restatement of existing behavior. **The actual reason is not ownership** — re-reading `verification.ts:157-165` this session shows source resolution is required for **every** actor, including SUPER_ADMIN, whose own authority never depends on course ownership at all (§10). It is a blanket, locked V1 fail-closed rule: an evidence row whose source cannot even be identified is refused for *any* verification-axis action, as an integrity check independent of who is asking. `revoke`/`reinstate` are the one place this document deliberately departs from that locked rule — not because their authority differs (ORG_ADMIN/SUPER_ADMIN, tenant-only, same shape either way), but because their entire purpose (§13, §16) is correcting evidence exactly when its source *cannot* be resolved (deleted lessons, refunded enrollments). **Decision, replacing a blanket E4 with a per-action rule:**

| Action | Requires source resolution? | Why |
|---|---|---|
| verify | Yes (unchanged) | Locked V1 fail-closed rule (`verification.ts:157-165`), applies to every actor including SUPER_ADMIN — not an ownership requirement |
| reject | Yes (unchanged) | Same rule, same function |
| unverify | Yes (new action, same rule) | Same rule |
| reopen | Yes (same rule) | Same rule |
| revoke | **No** — deliberate departure from the rule above | Its purpose (§13/§16) is specifically to correct evidence when the source is already unresolvable |
| reinstate | **No**, same departure | Same as revoke |

This means orphaned evidence from the §16 lesson-delete path can be `revoke`d (and later `reinstate`d) but never `reject`ed/`unverify`d/`reopen`ed once its source is gone — an acceptable, coherent boundary: correcting integrity problems is an administrative action by design (§13), while every verification-axis action keeps V1's blanket fail-closed rule unchanged.

**Cross-tenant existence leak — a real, pre-existing defect found this session, distinct from the tenant-consistency question above:** `setEvidenceVerificationStatus` returns 404 ("Evidence not found") when the row doesn't exist, but 403 ("Forbidden") when it exists in a *different* tenant (`verification.ts:188-189` vs. `:153-155`) — two distinguishable status codes, which violates E3/I3's "a record in another tenant MUST be indistinguishable from a missing one." **[verified this session: `verification.test.ts:189`'s "cross-tenant verification is rejected even for an INSTRUCTOR/SUPER_ADMIN role" test only asserts `rejects.toThrow(CapabilityVerificationError)`, never a specific status code — so no existing test actually pins the 403 behavior; nothing needs to be edited to fix this, only the code.]** **Recommended 30.3 fix:** `authorizeVerificationActor`'s tenant-mismatch branch should throw the same 404 as "not found," not a distinguishable 403 — added as D23 (§34).

---

## 26. Audit requirements — the section that decides the gate

**Finding, load-bearing for this document's gate decision:** the existing infrastructure **cannot** represent every verify/reject/unverify/reopen/revoke/reinstate transition, for three separate, specific reasons, each checked against the actual schema/code this session:

1. **`SkillProficiencyEvent` fires only when the level changes** (30.2's own, correctly-decided rule — §1, §21, not reopened). A verify on a learner's *second* piece of evidence for a skill they're already at INTERMEDIATE in produces no event at all. Neither does an unverify/reject/revoke that leaves another still-contributing row supporting the same level. **Today, that transition leaves no durable trace anywhere** except the mutable `verifiedById`/`verifiedAt` fields, which the next transition on the same row can overwrite.
2. **`LearningEvent` is contractually best-effort** (`emit.ts`, Phase 5, F12 — re-confirmed unchanged) and has no `previousState`/`newState`/`actor`/`reason` fields. It cannot be the audit substrate without reversing a locked architectural decision, which the contract already correctly rules out.
3. **`AdminAuditLog` cannot represent a tenant-scoped, per-evidence-row transition today**: it has no `tenantId` column at all (re-confirmed this session, `prisma/schema.prisma:945-959`), and its `action` field is constrained to a closed, unrelated union (`TENANT_SUSPENDED | TENANT_REACTIVATED | USER_ROLE_CHANGED | USER_PLAN_CHANGED`, `src/lib/admin-audit.ts:3-7`) that would need extending with capability-specific actions and a `targetType: "SkillEvidence"` case it does not have, plus a `tenantId` migration on an existing, populated table.

**This means 30.3 is not schema-free**, contrary to what a first read of the task might suggest. **Specified here, not built:** a new, minimal, append-only table — tentatively `EvidenceStandingEvent` — written in the *same* transaction as every verification-axis or state-axis transition (§13/§15), regardless of whether the level moved:

```
EvidenceStandingEvent
  id, tenantId, userId, skillId, evidenceId        (FK cascades matching SkillEvidence's own)
  evidenceRevision   Int      the revision THIS transition produced — same value the
                              paired SkillProficiencyEvent (if any) carries in its own
                              evidenceRevision field, giving a natural 1:0..1 join on
                              (evidenceId, evidenceRevision) with NO new foreign key —
                              SkillProficiencyEvent already has this exact unique pair.
  action             enum     VERIFY | REJECT | UNVERIFY | REOPEN | REVOKE | REINSTATE | EXPIRE | SUPERSEDE
  actorId            String?  null only for EXPIRE/SUPERSEDE (system-caused); FK onDelete SetNull,
                              mirroring SkillProficiencyEvent.actorId's own existing pattern
                              (schema.prisma:1232-1233) — a deleted actor never blocks the row.
  actorRole          Role?
  actorName          String?  a point-in-time snapshot of the actor's display name, taken at write
                              time — same convention as LearningAssignment.lastCancelledByName
                              (schema.prisma:928) — so the audit row remains readable ("revoked by
                              Jane Smith") after the actor's User row is later deleted, when actorId
                              itself has gone SetNull. Never re-derived from a live User lookup.
  reason             String?  required (enforced in code, not the DB) for REVOKE/REINSTATE
  previousVerificationStatus  EvidenceVerificationStatus
  newVerificationStatus       EvidenceVerificationStatus
  previousState               EvidenceState
  newState                    EvidenceState
  occurredAt         DateTime  business time
  recordedAt         DateTime  @default(now())

  @@unique([evidenceId, evidenceRevision])   -- one row per revision, mirroring
                                              -- SkillProficiencyEvent's own guarantee
  @@index([tenantId, evidenceId, recordedAt])
  @@index([tenantId, userId, recordedAt])
```

This is a small, purpose-built table (contract §27's own distinction — "audit event" vs. "`SkillProficiencyEvent`" serve different purposes — finally made concrete rather than left as a stated-but-unbuilt principle), not a generic audit framework: one action enum tied to exactly the transitions §13/§15 define, one join key already shared with the existing table, no new FK beyond the standard cascades already used elsewhere in this schema. It is **specified in this discovery document and NOT created in this phase** (the task's own explicit "do not modify Prisma schema" instruction governs); it is the first concrete deliverable of slice 30.3.0 (§33).

**Why this is not optional for the gate:** §13/§15's revoke/reinstate/unverify/reopen actions are the entire point of this phase, and every one of them can legally leave the level unchanged (e.g., revoking one of two supporting rows). Approving the phase without specifying where that transition's actor/reason/prior-state goes would ship an unauditable admin action — exactly the outcome this section and §31's testing-and-audit requirements exist to prevent.

---

## 27. Backward compatibility

Every existing row is already compatible under the interpretation 30.1/30.2 already fixed (`state = ACTIVE`, `validUntil = null`, `revision` as shipped) — re-confirmed, nothing new to reconcile, **with one exception: rows whose `occurredAt` was set by the backfill's cross-contamination bug (§1, D24) are not compatible with anything — they are simply wrong, and no interpretation of "existing data" rescues that.** A remediation pass for those rows is a data-fix, not a schema-compatibility question, and is out of this phase's scope to perform (though not to specify — see D24). Additions this phase's new fields require:

| Item | Compatible interpretation |
|---|---|
| Every existing `SkillEvidence` row | `state = ACTIVE` already (30.1 default + confirmed zero non-default rows outside test fixtures). No migration needed for §3/§13's new `REVOKED` value — it is additive to the existing enum, already declared. |
| Existing `verifiedById`/`verifiedAt` on REJECTED rows | Left exactly as-is (§15's decision not to clear on reject) — the pre-flight's 489-row finding stays true and stays correct, not "fixed." |
| New `EvidenceStandingEvent` table | Starts empty. No backfill attempted — 30.2's own precedent (`BASELINE` `SkillProficiencyEvent`) does not extend here, because there is no reliable source data for "who verified this and when" beyond what `verifiedById`/`verifiedAt` already (imperfectly) record, and fabricating one row per historical verify would invent actors/reasons/prior-states the data does not actually contain. **Decision: audit history begins at first-30.3-transition, exactly like `SkillProficiencyEvent`'s own `BASELINE` boundary (contract D12), stated explicitly rather than left to be assumed.** |
| `EvidenceVerificationStatus.PENDING` | Still zero production writers; unaffected by anything in this phase. |

---

## 28. API impact

| Route | Class | Change |
|---|---|---|
| `POST /api/capability/evidence/[id]/verify` | E, B | `bodySchema`'s `action` enum gains `unverify`, `reopen`, `revoke`, `reinstate`; `revoke`/`reinstate` additionally require a `reason` string field (new, required only for those two actions — `z.discriminatedUnion` or a superRefine, not a flat optional field, so `verify`/`reject`/`unverify`/`reopen` remain unchanged in shape). Re-verify becomes a true no-op (D10) — a behavior change from "always overwrites." `EvidenceReviewList.tsx` (the one client hard-coding the `"verify" \| "reject"` union, confirmed unchanged this session) needs no change to keep working — Zod's `.enum` additivity (confirmed again, `route.ts:9-11`) means a client sending only the two existing literals is unaffected. |
| `GET /api/capability/recommendations` | U | No change from this phase — the G1 guard (30.1) already governs `isAssessable`; nothing about verification/revocation semantics touches recommendation ranking. |
| `GET /api/org/capability`, `/api/instructor/capability(+[learnerId])` | U | No change from this phase — these reports already read `met`/`current`/`required` only and do not surface confidence or evidence standing; 30.3 does not add fields to them (that is 30.6's scope per the contract's own slicing, not moved up here). |
| `GET /api/capability/evidence/[evidenceId]` or equivalent history read | **Not built here** — reading `EvidenceStandingEvent`/`SkillProficiencyEvent` is 30.4's scope, unchanged from the contract's own slicing. |
| `/api/cron/expire-evidence` | **Deferred** (§5) — not built until a `validUntil` writer exists. |

No existing response shape breaks. The one behavior change an existing consumer could observe is re-verify becoming idempotent (D10, already flagged as needing explicit approval in the original contract, still true here).

---

## 29. Scheduled processing

Re-decided against this session's findings, correcting the original contract's assumption that D6 ("daily expiry cron") is ready to build now:

| Job | Needed in 30.3? | Reason |
|---|---|---|
| Expiry cron | **No.** | Zero rows have `validUntil` set (§5). Building it now runs a no-op job forever until 30.8. Deferred to whichever slice first writes `validUntil` (30.8, CERTIFICATION). |
| Confidence refresh job | **No.** | §6 — no UI consumer exists yet to justify bounding the staleness lag; lazy (recompute-on-next-real-transition) is accepted. |
| Reconciliation job (ongoing) | **No, beyond what 30.2 already built.** | `reconcileTenant`/`reconcileAllTenants` already exist as callable functions (not scheduled); nothing in 30.3's scope needs a new scheduled reconciliation — the reconciliation proof was a one-time cutover gate, not an ongoing job. |
| Lazy evaluation everywhere else | **Yes, preferred, matching everything else in this document.** | Every predicate (`isEvidenceValid`, `isFresh`, `doesEvidenceContribute`) is already evaluated at read/recompute time, never materialized speculatively. |

If/when the expiry cron is eventually built (30.8+), its cadence/scope/idempotency/tenant-isolation/failure-recovery should follow the two existing crons' own pattern (`vercel.json`'s `downgrade-subscriptions`/`decay-streaks`, both `CRON_SECRET`-authenticated, both per-tenant-isolated with independent failure handling) — not re-designed from scratch. Not specified further here since it is out of this phase's scope.

---

## 30. Security review

| Risk | Finding this session |
|---|---|
| Privilege escalation through verification | No new escalation surface found — every new action (§13/§15) reuses the existing tenant-match + role-authorization pattern; `revoke`/`reinstate` are additionally restricted to ORG_ADMIN/SUPER_ADMIN only (never INSTRUCTOR), narrower than verify/reject, not wider. |
| Self-verification | Still refused unconditionally, first check in `authorizeVerificationActor`, before any of this phase's new logic would run (§11). |
| Cross-tenant evidence actions | Unchanged, still refused — §25. |
| Unauthorized revocation | Addressed by design: `revoke`/`reinstate` require ORG_ADMIN/SUPER_ADMIN and a reason; no INSTRUCTOR or STUDENT path reaches them. |
| Unauthorized access to evidence history | Not yet a live risk — no history read API exists (30.4). Worth stating now so 30.4 inherits the same instructor-owns-the-source-course scoping `getReviewableEvidenceForInstructor` already uses (D16), not a new, looser rule. |
| Deleted-user/source behavior | §16's learner-`deletedAt` gap is real and unfixed today — flagged as a required 30.3 fix, not merely documented (§16, last paragraph). |
| Forged assessor/verifier ids | n/a — no assessor path exists yet (30.8). For the verification actions that do exist, `actorId` is always taken from the authenticated `AuthContext`, never from the request body (confirmed: `bodySchema` has only `action`, no actor field) — cannot be forged by a client. |
| Stale authorization context | The check-then-write gap in §14 is the one genuine structural risk found this session beyond what the prior audits already covered — not a privilege-escalation risk (the actor's own role/tenant can't change mid-request), but a correctness risk for any precondition 30.3 adds (e.g., "refuse if already REVOKED") that a check-before-transaction cannot enforce reliably under concurrency. §14's fix (move the check inside the lock) is the mitigation. |

No capability transition trusts client-supplied tenant or user identity anywhere in the current or proposed design — confirmed again this session, not merely repeated from the prior audits.

---

## 31. Testing contract

Before-implementation test list for 30.3, organized by the task's own categories. Tests **not yet written** are marked `[new]`; tests that already exist and must keep passing unmodified through 30.3 (contract §M) are marked `[existing, unmodified]`.

**State machine:**
- `[new]` Every allowed transition in §15's table, both axes (verification and state), from a dedicated pure-function test (once the transition logic is extracted similarly to how `evaluateRequirement`/`ceilingFor` are pure — this phase's implementation should keep the transition-legality check itself pure and DB-free, testable without a database, matching the existing `readiness.ts`/`proficiencyPolicy.ts` convention).
- `[new]` Every forbidden transition (REVOKED/EXPIRED/SUPERSEDED → VERIFIED) refused with the new distinct error.

**Verification:**
- `[existing, unmodified]` First verification, verify-then-reject sequences (`verification.test.ts`'s current suite).
- `[new]` Re-verification is a true no-op: `verifiedById` unchanged, `revision` unchanged, no new `SkillProficiencyEvent`, no new `EvidenceStandingEvent`.
- `[new]` Verification after revocation is refused; verification after reinstate succeeds normally.
- `[existing, unmodified]` Self-verification attempts, cross-tenant attempts (`verification.test.ts:60,78` and similar).

**Invalidation:**
- `[new]` Revoke excludes contribution immediately, in the revoking transaction.
- `[new]` Revoke works when the source cannot be resolved (the one precondition divergence from verify/reject, §25).
- `[new]` Reinstate restores the prior `verificationStatus` exactly, without re-running verification's authorization/source-resolution chain.
- Expiry and supersession: **not tested in 30.3** — no writer exists to test against (§5, §20). A pure-function test of the *predicate* (`isEvidenceValid` at the exact `validUntil` boundary) already exists from 30.1/30.2's own suite and needs no addition.

**Confidence:**
- `[existing, unmodified]` `proficiencyPolicy.test.ts`'s existing fresh/stale/verified/unverified/multiple-source/invalid-evidence cases.
- `[new]` The §6 invariant: under Policy 1, `HIGH` is reachable only from `INTERMEDIATE`, `LOW` only from `BEGINNER` — exhaustive over the finite domain, not a spot check.
- `[new]` A confidence-only change (second row verified, level already at the ceiling) produces zero `SkillProficiencyEvent` rows and exactly one `EvidenceStandingEvent` row.

**Recompute:**
- `[existing, unmodified]` Every transition that changes contribution already invokes `projectUserSkill` — re-proven by the new transitions reusing the same call, not a new code path.

**Concurrency (real database, per §14's fix):**
- `[new]` verify vs. revoke on the same row, racing via a shared barrier (same pattern as `proficiency.concurrency.test.ts`'s C2′ — two real calls, no decoy).
- `[new]` verify vs. reject on the **same** row (not the different-rows case C1/C3 already cover).
- `[new]` revoke vs. a concurrent recompute triggered by unrelated evidence on the same skill.
- `[new]` Two state transitions simultaneously on one evidence row — proves the `SkillEvidence`-row lock ordering from §14 holds (no deadlock against `projectUserSkill`'s own `UserSkill` lock).

**Failure isolation:**
- `[new]` The new audit-row write and the (possible) `SkillProficiencyEvent` write are atomic with the evidence-standing update — a forced failure on the audit-row insert rolls back the entire transition, same discipline as F11.

**Missing today, flagged for 30.3 regardless of the rest of this phase's scope:**
- `[new]` J1/INV17, framed as one general invariant test: `learning-assignment` never writes `SkillEvidence`, under any action. Two narrower, scenario-specific tests already assert this incidentally (§19); this adds the general form, covering assign/cancel/reactivate together, not new *behavior*.
- `[new, not 30.3 scope, but required whenever D24 is fixed]` A two-learners-one-course (and separately, two-learners-one-quiz) `backfillTenant` test asserting each learner's `SkillEvidence.occurredAt` ends up equal to *their own* `Enrollment.completedAt`/passing `QuizAttempt.completedAt`, not another learner's. This is the regression test §1's confirmed backfill bug (D24) is currently missing — flagged here so it accompanies the fix whenever that code change happens, not deferred indefinitely alongside it.

---

## 32. Overengineering review

| Idea | Classification | Reason |
|---|---|---|
| Hard proficiency decay | **Rejected for now** | Unchanged from the discovery; nothing this session found changes the calculus — no decay parameters exist to justify one. |
| Numerical confidence scores | **Rejected for now** | Unchanged; three categorical values remain sufficient and explainable. |
| ML confidence | **Rejected for now** | Unchanged; no requirement, conflicts with the domain-decides boundary. |
| Generic evidence lifecycle framework | **Rejected** | §26's `EvidenceStandingEvent` is deliberately narrow (one enum, one join key, no generic "workflow state" concept) — a generic framework was considered and rejected in favor of this. |
| Automatic source polling/invalidation | **Rejected for now** | §16 — no new integration into `Enrollment`/`QuizAttempt`/`AssignmentSubmission` state; `revoke` (manual) is the only currently-buildable option. |
| Elaborate evidence version graphs | **Rejected** | Supersession stays a single-successor pointer (30.8), never a graph; §20 defers even that. |
| Configurable per-tenant weighting | **Rejected for now** | Unchanged — `CURRENT_POLICY_VERSION` remains the only knob, a code constant. |
| Complex event sourcing | **Rejected** | Unchanged — the projection remains a cache over the current evidence set, never replayed from events. |
| **Type-aware grant table (Policy 2's `C3`)** | **Deferred past 30.3, to 30.8** — see §34's new decision D19 | Not previously flagged as a landmine: `MANUAL`-typed evidence is the de facto generic fixture type across this repo's test suite — **[verified this session: `grep -rlE 'type: "MANUAL"' src --include="*.test.ts" | wc -l` returns 12 test files — the type-scoped count; a broader, unscoped `"MANUAL"` grep returns 29, but that also matches unrelated enum values, `AssignmentSource.MANUAL` and `KnowledgeSourceType.MANUAL`, so 12 is the real blast-radius figure]** (the pre-flight's ~4,800-row count, §13, measures accumulated *database* rows across many sessions' test runs, a different and less directly relevant measurement) and is used directly in `policyReconciliation.test.ts`'s own `evidenceRow` helper (`type: "MANUAL"`) expecting `VERIFIED` to grant `INTERMEDIATE`. Contract C3 makes `MANUAL` grant `NONE` always (reserved). Shipping the type-aware table in 30.3 would silently break every one of those 12 files' tests using that fixture pattern — a real, if now precisely bounded, regression risk found by actually reading the fixture helper, not a hypothetical. Policy 1's type-agnostic `ceilingFor` is kept as the live policy through 30.3; only validity/verification/confidence semantics change this phase, never what grants what. |
| Confidence refresh job / expiry cron | **Deferred, not rejected** | §5/§6/§29 — both would be premature scheduled processing for state nothing writes yet. |

---

## 33. Implementation slicing recommendation

Adjusted from the task's own §35 suggestion for one dependency reason found this session: **the audit table (§26) is not an independent later concern — every verification-axis and state-axis transition in 30.3.1 needs somewhere to write to from its first commit**, so it belongs in the foundation slice, not bolted on after.

| Slice | Scope |
|---|---|
| **30.3.0** | Schema: `EvidenceStandingEvent` table (§26); `state = REVOKED` becomes a real target (no new enum values needed — `ACTIVE`/`REVOKED` already exist); no behavior change yet. |
| **30.3.1** | Verification semantics: move the check-then-write into the lock (§14); idempotent re-verify/reject (D10 + its symmetric case); `unverify`, `reopen`; ORG_ADMIN lowering authority (D3); the learner-`deletedAt` check (§16); every write now also produces an `EvidenceStandingEvent` row. |
| **30.3.2** | `revoke`/`reinstate` (§13) — the one genuinely new action pair, admin-only, reason-required, no source-resolution requirement. |
| **30.3.3** | Confidence: the §6 boundary invariant tests; no runtime change (the calculation is already correct and live). |
| **30.3.4** | API surface: the `verify` route's extended action enum, discriminated on `reason` (§28). |

**Explicitly NOT in 30.3, confirmed by this document's own findings, not merely inherited:** the expiry cron (§5/§29, no writer exists), confidence refresh job (§6/§29, no consumer exists), supersession (§20, no schema for it), the type-aware Policy 2 grant table (§32, would break the ~12 test files using the `type: "MANUAL"` evidence fixture pattern), history read endpoints (30.4, unchanged), role-readiness-V2 consumer migration (30.5, unchanged), any assessor-path work (30.8, unchanged).

---

## 34. Open decisions requiring explicit approval

Carried forward from the original contract's §P where still open, plus new items this document raises:

| ID | Decision | Status after this document |
|---|---|---|
| D3 | ORG_ADMIN gains reject/unverify/revoke, still not verify | **Recommend approve**, unchanged reasoning, now with a concrete transition table (§15) |
| D6 | Daily expiry cron | **Re-scoped**: approved in principle, **not built in 30.3** — deferred to whichever slice first writes `validUntil` |
| D10 | Idempotent re-verify | **Recommend approve**, now specified precisely (§14/§15), including the previously-unstated symmetric REJECTED→REJECTED no-op |
| D19 *(new)* | Keep Policy 1's type-agnostic grant table through 30.3; defer the type-aware Policy 2 table to 30.8 | **Recommend approve** — required to avoid the ~12-test-file `MANUAL`-fixture regression (§32) |
| D20 *(new)* | Add `EvidenceStandingEvent` as a new, minimal append-only table in 30.3.0 | **Recommend approve** — required for §26's gate; the alternative (no audit trail for level-unchanged transitions) is not acceptable for an admin-facing revoke/unverify action |
| D21 *(new)* | Move verification's check-then-write inside a `SELECT ... FOR UPDATE` transaction on the `SkillEvidence` row, locked in the fixed order (SkillEvidence, then UserSkill) | **Recommend approve** — required for D10/D19's correctness under concurrency (§14) |
| D22 *(new)* | Add the missing `deletedAt` check on the evidence's own learner inside `authorizeVerificationActor` | **Recommend approve** — a real, confirmed gap (§16), not a new feature |
| D24 *(new)* | Re-key `capabilityBackfill.ts`'s `occurredAt` lookups by learner, not just course/quiz id, before any further production backfill run; explicitly re-derive already-affected rows | **Not a recommendation — a confirmed defect (§1)**, empirically proven against `lumio_test` (73 affected courses). Fixing the code is out of this discovery phase's scope; the finding and its fix requirement are recorded so it is not lost. |
| D23 *(new)* | Fix the cross-tenant existence leak: return the same 404 for a cross-tenant `evidenceId` as for a missing one, never a distinguishable 403 | **Recommend approve** — a real, pre-existing defect (§25), not new scope; no existing test pins the current 403 behavior, so nothing needs to be edited to fix it |
| D9 | Learner "request verification" (`PENDING`) | Unaffected, still deferred |
| D11 | Reserved event causes stay declared, un-emitted where not yet applicable | Unaffected — `EVIDENCE_EXPIRED`/`EVIDENCE_SUPERSEDED` remain declared, un-emitted until 30.8 |
| D16 | Instructor history scope = evidence they own the source of | Unaffected, reaffirmed for whenever 30.4 reads `EvidenceStandingEvent` too |
| D17 | Single policy-version constant, no per-tenant config | Unaffected |

---

## 35. Final recommended contract (30.3 scope only)

1. Verification stays a two-axis system: `verificationStatus` (trust) and `state` (in-force), each transitioned by a disjoint, explicit action set — never merged, never inferred from the other.
2. Every verification-axis or state-axis transition writes a new `EvidenceStandingEvent` row, unconditionally, in the same transaction as the `SkillEvidence` update — independent of whether a `SkillProficiencyEvent` also fires. `SkillProficiencyEvent`'s existing level-changed-only rule (30.2) is not reopened.
3. `revoke`/`reinstate` are new, ORG_ADMIN/SUPER_ADMIN-only, reason-required, state-axis-only actions that never touch `verificationStatus` and never require source resolution.
4. `unverify`/`reopen` are new, verify-set + ORG_ADMIN, verification-axis-only actions. Neither clears `verifiedById`/`verifiedAt` — no transition does (§15's unified rule): the field is a legacy "most recent verifier" snapshot, never a live trust signal, and the complete per-action history lives only in `EvidenceStandingEvent`.
5. Re-verify and re-reject become true idempotent no-ops (D10 and its symmetric case) — enforced by moving the check-then-write inside a locked transaction (D21), the same locking discipline `proficiency.ts` already established one layer up.
6. Confidence's calculation, aggregation, and never-an-input/never-settable boundary are unchanged — already correct, re-verified this session. Its staleness (§6) is an accepted, documented limitation, not fixed with a new job. `CURRENT_POLICY_VERSION` does not bump for anything in this phase's scope (§6).
7. `validUntil`/expiry, supersession, and the type-aware Policy 2 grant table are **explicitly deferred**, not because they are hard, but because nothing in the current schema or codebase can trigger them yet (§5, §20, §32) — building any of them now would be dead code with a live-looking test suite around it, or (for Policy 2) an active regression against existing fixtures.
8. The learner-`deletedAt` gap (D22) and the cross-tenant existence leak (D23) in current verification authorization are real, pre-existing defects, fixed as part of this phase, not deferred.
9. Source resolution is required for every verification-axis action (verify/reject/unverify/reopen, unchanged from today) but never for the two new state-axis actions (revoke/reinstate) — a per-action rule (§25), not the contract's original blanket claim that all lowering actions skip it.

---

## 36. Final gate

Approved with the scope narrowed exactly as this document specifies: 30.3 ships the verification-axis and state-axis (revoke/reinstate only) transition semantics, their authorization, their concurrency fix, and the new `EvidenceStandingEvent` audit table — not the expiry cron, not supersession, not the type-aware Policy 2 grant table, not confidence history, not history read APIs. Every deferral above is deferred because this session traced a concrete reason (no writer exists, or a live fixture would break), not because it was untouched by habit. No critical semantic decision needed for the scope above remains unresolved; the decisions still open (D6's re-scoping, D19-D24) are recommendations with a stated default, not blockers. **D24 (the backfill cross-contamination bug, §1) is the one item in this range that is not merely a design recommendation but a confirmed defect in already-shipped code** — approving the gate does not require fixing it in this phase, but it should not be forgotten before 30.3 (or anything else) relies on `occurredAt`-derived freshness.

```text
PHASE_30.3 IMPLEMENTATION APPROVED
```
