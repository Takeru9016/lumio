# Phase 30 — Capability & Proficiency V2: Contract

Status: PROPOSED. Not in force until the decisions marked `[D#]` are approved. Rationale and evidence: `docs/PHASE_30_CAPABILITY_PROFICIENCY_V2_DISCOVERY.md`.
Conventions: MUST / MUST NOT / MAY are normative. "V1" means the behavior at commit `2a165ea`. Rule IDs are stable and are meant to be cited from implementation prompts and tests.

---

## A. Model

**A1.** Levels are the ordered set `NONE < BEGINNER < INTERMEDIATE < ADVANCED < EXPERT` (`SkillProficiency`). The enum MUST NOT change. Order MUST come from the hand-written `PROFICIENCY_ORDER`, never from enum declaration order. [D1]

**A2.** `SkillEvidence` is the source of truth. `UserSkill` is a cache: for every (tenantId, userId, skillId), `UserSkill.proficiency` MUST equal `level(validEvidence, policy, asOf)` as of its last write.

**A3.** `UserSkill.proficiency` MUST be written only by `recomputeUserSkill`. No other code path MAY write `UserSkill`.

**A4.** Proficiency MUST NOT be set, incremented or decremented directly by any request, actor, admin or AI. It changes only when the valid evidence set or the policy changes.

**A5.** Mastery is not a concept. There is no `mastery` field, flag or term; `EXPERT` is the top level.

**A6.** Existing, valid and contributing are three separate predicates (B1-B3).

---

## B. Evidence

**B1. exists** — a `SkillEvidence` row is present in any state.

**B2. valid(e, asOf)** — ALL of:
```
e.state = ACTIVE
e.verificationStatus != REJECTED
e.validUntil IS NULL OR e.validUntil > asOf
e.tenantId = user.tenantId = skill.tenantId
```

**B3. contributes(e, asOf)** — `valid(e, asOf) AND grant(policy, e) > NONE`.

**B4.** Evidence MUST NEVER be deleted by application code. Invalid evidence is excluded from calculation and stays visible with its state, actor and reason. Only FK cascades from tenant, user or skill remove rows.

**B5.** An observation's content is immutable: `type`, `sourceType`, `sourceId`, `score`, `scorePercent`, `occurredAt`, `assessedLevel`. Only `verificationStatus`, `state` and `revision` change, and only through audited transitions.

**B6.** The unique key `[tenantId, userId, skillId, sourceType, sourceId]` MUST be kept unchanged and remains the concurrency guarantee for evidence creation. P2002 on it is a benign idempotent no-op.

**B7.** First evidence wins: a later qualifying event for the same key MUST NOT change `score`, `scorePercent` or `occurredAt`.

**B8.** Evidence source ids MUST NOT be trusted. Tenant consistency is re-checked at write and by `valid()`.

### B9. Evidence writers (unchanged from V1)

| Type | sourceType / sourceId | Written when | Notes |
|---|---|---|---|
| COURSE_COMPLETION | `"Course"` / courseId | Enrollment transition to COMPLETED wins; reconcile; new `CourseSkill` backfill | `occurredAt = Enrollment.completedAt` |
| QUIZ_SCORE | `"Quiz"` / quizId | Attempt passed | Failed attempts write nothing. Legacy `"QuizAttempt"` rows remain valid |
| ASSESSMENT | `"AssignmentSubmission"` / submissionId | Assignment graded (any score) | `scorePercent = score / maxScore` snapshot |

Types `ASSIGNMENT`, `PROJECT`, `MANUAL` have no writer and grant NONE. `AI_EVALUATION` grants NONE always. `MANAGER_ASSESSMENT` and `CERTIFICATION` are written only by the assessor path (slice 30.8). [D2]

---

## C. Policy and progression

**C1.** `level = max({NONE} ∪ {grant(policy, e) | valid(e, asOf)})`. No sums, no weights, no accumulation.

**C2. Policy 1** (V1-equivalent, type-agnostic): non-rejected UNVERIFIED or PENDING grants BEGINNER; VERIFIED grants INTERMEDIATE; REJECTED grants NOTHING.

**C3. Policy 2** (target):

```
grant:
  COURSE_COMPLETION : { UNVERIFIED: BEGINNER, PENDING: BEGINNER, VERIFIED: INTERMEDIATE }
  QUIZ_SCORE        : { UNVERIFIED: BEGINNER, PENDING: BEGINNER, VERIFIED: INTERMEDIATE }
  ASSESSMENT        : { UNVERIFIED: BEGINNER, PENDING: BEGINNER, VERIFIED: INTERMEDIATE }
  MANAGER_ASSESSMENT: min(assessedLevel, authorityCeiling)      # created VERIFIED; cap EXPERT
  CERTIFICATION     : min(assessedLevel, ADVANCED)              # created VERIFIED
  PROJECT, ASSIGNMENT, MANUAL : NONE   (reserved)
  AI_EVALUATION     : NONE             (never contributes)
maxGrantableLevel(policy1) = INTERMEDIATE
maxGrantableLevel(policy2, before 30.8) = INTERMEDIATE
maxGrantableLevel(policy2, after 30.8)  = EXPERT
```

**C4.** Policy 2 MUST produce output identical to policy 1 for every existing V1 row (types in B9, ACTIVE, `validUntil` null). This is checked, not assumed (H3).

**C5.** `score` and `scorePercent` MUST NOT affect the level. [D13]

**C6.** ADVANCED and EXPERT MUST be reachable only through assessed-level evidence. They MUST NOT be reachable by accumulating activity evidence.

**C7. Assessor authority** (slice 30.8) [D2]: course-owning INSTRUCTOR may assert up to ADVANCED for a learner enrolled in their course; ORG_ADMIN may assert up to EXPERT within their tenant; SUPER_ADMIN is tenant-bound. The subject MUST NOT assess themselves. A new assessed-level row SUPERSEDES the learner's earlier assessed-level row for that skill in the same transaction.

**C8.** Time decay of activity evidence MUST NOT exist in Phase 30. [D4] Only explicit `validUntil` expires evidence.

---

## D. Confidence

**D1.** Confidence is DERIVED, categorical (`LOW | MEDIUM | HIGH`), stored as a cache in `UserSkill.evidenceConfidence`, and NULL when the level is NONE.

**D2.** Definition, where `supporting` = valid evidence whose grant equals the projected level, and `fresh(e)` = age since `occurredAt` at most 365 days (or `validUntil` in the future when set): [D5]
```
HIGH   : supporting has a VERIFIED-or-assessed row that is fresh
MEDIUM : supporting has a VERIFIED-or-assessed row that is not fresh
         OR supporting has UNVERIFIED rows of >= 2 distinct evidence types
LOW    : otherwise
```

**D3.** Confidence MUST NOT be an input to level. It MUST NOT be settable by any request, admin or AI. Corroboration counts evidence types, never raw source ids.

**D4.** Confidence MUST NOT gate role readiness. It qualifies a MET result only. No per-role minimum confidence.

**D5.** The freshness window is a code constant versioned by `policyVersion`. It MUST NOT be tenant-configurable. [D17]

**D6.** `UserSkill.confidence` (Int), `targetProficiency`, `status` and `SkillEvidence.userSkillId`, `proficiency`, `metadata` are deprecated and MUST NOT be written or reused. They are not dropped in Phase 30. [D14]

---

## E. Verification and validity transitions

Two independent fields. `verificationStatus` (V1 enum) and `state` (new): `ACTIVE | SUPERSEDED | EXPIRED | REVOKED`.

### E1. Transitions and authority

| Action | Transition | Actors | Class |
|---|---|---|---|
| verify | UNVERIFIED, PENDING, REJECTED → VERIFIED | course-owning INSTRUCTOR; SUPER_ADMIN | raising |
| reject | UNVERIFIED, PENDING, VERIFIED → REJECTED | verify actors; ORG_ADMIN [D3] | lowering |
| unverify | VERIFIED → UNVERIFIED (clears verifiedById/At) | verify actors; ORG_ADMIN [D3] | lowering |
| reopen | REJECTED → UNVERIFIED | verify actors | raising |
| request | UNVERIFIED → PENDING | the learner only | deferred [D9] |
| revoke | state ACTIVE → REVOKED (reason required) | ORG_ADMIN; SUPER_ADMIN; system integrity check | lowering |
| reinstate | state REVOKED → ACTIVE (reason required) | ORG_ADMIN; SUPER_ADMIN | raising, restores only |
| expire | state ACTIVE → EXPIRED when `validUntil <= now` | system (cron) | lowering |
| supersede | state ACTIVE → SUPERSEDED on new assessed-level row | system, same transaction | any |

**E2.** The subject of the evidence MUST NEVER perform verify, reject, unverify, reopen, revoke or reinstate on their own evidence.

**E3.** Every action MUST be tenant-checked: evidence tenant equals actor tenant. Cross-tenant MUST fail as not found or forbidden without revealing existence.

**E4.** Raising actions on activity evidence MUST resolve the source to a course and follow V1 authority. Lowering actions MUST NOT require the source to resolve.

**E5.** ORG_ADMIN MUST NOT verify. ORG_ADMIN authority over capability level is through the assessor path only. [D3]

**E6.** A soft-deleted learner's evidence MUST NOT be acted on. It is retained and excluded from reports.

**E7.** Transitions MUST be compare-and-swap on `revision`. A stale revision fails without changing anything.

**E8.** Re-applying an action already in effect is an idempotent no-op that keeps the first actor. [D10]

**E9.** Deleting a source record does NOT invalidate its evidence. Evidence from a foreign or inconsistent tenant NEVER contributes (B2).

**E10.** A `CourseSkill` mapping removal MUST NOT touch existing evidence or projection (Phase 22, unchanged).

---

## F. Recalculation and history

**F1.** `recomputeUserSkill(tx, key)` runs inside the caller's transaction and MUST, in order: (1) ensure the `UserSkill` row exists (`ON CONFLICT DO NOTHING`); (2) `SELECT … FOR UPDATE` it; (3) read the evidence set under the lock; (4) compute level and confidence; (5) write the projection, `eventSeq`, `policyVersion`; (6) append the event.

**F2.** Every path that changes evidence or its standing MUST call it in the same transaction as the evidence change. No exceptions.

**F3.** `lastAssessedAt` keeps its V1 meaning: set on first creation and when the level value changes; unchanged otherwise.

**F4.** `SkillProficiencyEvent` is append-only. Rows MUST NOT be updated or deleted by application code.

**F5.** One event MUST be written for every evidence transition that reaches the projection, including transitions that leave the level unchanged.

**F6.** Event fields: `tenantId, userId, skillId, seq, cause, evidenceId?, evidenceRevision?, actorId?, actorRole?, reason?, previousProficiency?, newProficiency, previousConfidence?, newConfidence?, policyVersion, contributing (json: ids and enums only), occurredAt, recordedAt`.

**F7.** `cause ∈ BASELINE | EVIDENCE_ADDED | EVIDENCE_VERIFIED | VERIFICATION_REVOKED | EVIDENCE_REJECTED | EVIDENCE_REOPENED | EVIDENCE_EXPIRED | EVIDENCE_SUPERSEDED | EVIDENCE_REVOKED | EVIDENCE_REINSTATED | RECALCULATED`.

**F8.** Constraints: unique `[userId, skillId, seq]`; unique `[evidenceId, evidenceRevision]`; indexes `[tenantId, skillId, recordedAt]`, `[tenantId, userId, skillId, recordedAt]`, `[tenantId, cause, recordedAt]`.

**F9.** Ordering within (user, skill) is `seq`. `recordedAt` is the "as of" clock. `occurredAt` is business time and MAY be backdated.

**F10.** Chain invariant: for consecutive events of one (user, skill), `previousProficiency` of event n+1 equals `newProficiency` of event n; `seq` has no gaps.

**F11.** If the event cannot be written, the evidence transition MUST roll back. The learner-facing outer boundaries stay as in V1 (quiz outcome never throws; completion evidence guarded, rethrown after side effects; reconciliation retryable).

**F12.** `LearningEvent` is NOT the audit substrate and MUST NOT be made transactional in Phase 30. `SKILL_ASSESSED` and `SKILL_EVIDENCE_CREATED` stay reserved and un-emitted. [D11]

**F13.** History before V2 is not reconstructible. Backfill writes one `BASELINE` event per existing `UserSkill`. [D12]

**F14.** No snapshot table. No canonical event sourcing. No readiness-history table.

---

## G. Role readiness

**G1.** One pure evaluator, no I/O, MUST be used by `computeCapabilityGap`, both capability reports, all three copilot contexts, the recommendation engine and the gap-assignment guard. No consumer MAY compare levels inline.

**G2.** Requirement status:
```
MET            current >= required
BELOW          NONE < current < required
MISSING        current = NONE
NOT_ASSESSABLE required > maxGrantableLevel(policy)
```
`NOT_ASSESSABLE` is derived from the policy table. Nothing sets it. It disappears when the reachable ceiling rises.

**G3.** `RequirementResult` = `{ skillId, requiredLevel, currentLevel, status, levelsShort, confidence, supportingEvidence[], lastChange | null }`.

**G4.** `RoleReadiness` = `{ ready: boolean | null, met, total, requirements[] }`. `ready` is `null` when the role has no requirements. `ready` is true only when every requirement is MET.

**G5.** No aggregate percentage is defined, and none MAY be the sole explanation. Every "not ready" statement MUST be generated from the per-requirement results.

**G6.** `NOT_ASSESSABLE` counts as not met, is reported separately, and MUST be excluded from recommendations and from gap assignments (`createCapabilityGapAssignment`). [D7, D15]

**G7.** Requirement selection stays V1: `RoleSkill.isRequired = true`, skill `ACTIVE`, role inside the tenant. A `met` value at or below the reachable ceiling MUST be byte-identical to V1.

**G8.** Expired evidence lowers readiness through recomputation; aged evidence changes only confidence.

**G9.** "When did I become ready" is computed from events against CURRENT requirements. Requirement history is not stored.

---

## H. Migration and reconciliation

**H1.** Sequence: S0 read-only audit → S1 additive schema → S2 idempotent backfill → S3 shadow computation → S4 reconciliation proof → S5 cutover on policy 1 → S6 semantic activation, one feature per slice.

**H2.** S1 MUST be additive only: nullable or defaulted columns, new enums, one new table, indexes. No column dropped or retyped. Zero downtime.

**H3.** S5 MUST NOT be enabled until reconciliation shows, over every (tenant, user, skill): stored `proficiency` equals the policy-1 recompute; the shared evaluator equals every V1 comparison for every (learner, role) pair; V1 API responses equal golden responses apart from added fields. Every difference is listed and explained.

**H4.** One server-side constant `CAPABILITY_POLICY_VERSION` (plus a shadow-mode switch) is the only flag. No per-tenant flags or configuration. [D17]

**H5.** Rollback of S6: set the constant to 1 and recompute. History events remain by design.

**H6.** S0 queries (recorded in the phase audit): reserved-type and PENDING rows (expect 0); tenant inconsistencies on evidence, `UserSkill`, `RoleSkill`, `CourseSkill`; `UserSkill` drift versus V1 recompute; `RoleSkill` requiring ADVANCED or EXPERT per tenant; unresolved sources; legacy `"QuizAttempt"` rows; users with more than one primary role; existing gap assignments above INTERMEDIATE.

**H7.** Backfill: `occurredAt` from `Enrollment.completedAt` / earliest passing `QuizAttempt.completedAt` / `AssignmentSubmission.gradedAt`, else `createdAt`; `scorePercent` quiz = `score`, assessment = `score / Assignment.maxScore` when resolvable else NULL (NULL means unknown, never 0); one BASELINE event per `UserSkill`; `state = ACTIVE`, `revision = 0`. Running it twice MUST give identical results.

**H8.** Composite tenant FKs `(userId, tenantId) → User(id, tenantId)` and `(skillId, tenantId) → Skill(id, tenantId)` on `SkillEvidence`, `UserSkill`, `SkillProficiencyEvent`, only if the S0 audit finds no violating rows. [D8] No tenant columns are added to `RoleSkill` or `CourseSkill`.

**H9.** Expiry runs as a daily cron authenticated with `CRON_SECRET`, isolated and idempotent per (user, skill); a failure for one learner MUST NOT block others; re-running recovers. Maximum lag one day. [D6]

---

## I. Tenant and security

**I1.** Every capability record MUST be readable and mutable only within its own tenant. Tenant comes from the resolved auth context, never from a request parameter.

**I2.** Learner reads own evidence, projection and events. Instructor reads a learner's evidence and events only for evidence whose source course the instructor owns and for a learner with a shared enrollment. ORG_ADMIN reads tenant-wide through reports. [D16]

**I3.** Every new endpoint MUST call `requireTenant`. A record in another tenant MUST be indistinguishable from a missing one.

**I4.** AI routes MUST call the same authorised domain functions as pages.

---

## J. Assignment boundary

**J1.** `LearningAssignment` state (assigned, started, completed, overdue, cancelled) is NEVER evidence. It MUST NOT write `SkillEvidence`. A test MUST assert this for the `learning-assignment` module.

**J2.** Completion of an assigned course produces evidence only through the ordinary COURSE_COMPLETION path.

**J3.** Cancellation and overdue MUST NOT touch capability state.

**J4.** `Assignment` / `AssignmentSubmission` grading remains the ASSESSMENT writer; any graded score qualifies. A pass mark requires a new `Assignment` field and is out of scope. [D13]

---

## K. AI boundary

**K1.** AI MAY read: level, requirement results (status, confidence), recency signals, gaps, own-scope history, learning activity. AI MAY explain, summarise and recommend.

**K2.** AI MUST NOT: assign or change proficiency, confidence or readiness; override, un-verify or reject verified evidence; create contributing evidence; bypass tenant or role authorisation; alter role requirements or course-skill mappings; advise steps toward a `NOT_ASSESSABLE` requirement.

**K3.** `AI_EVALUATION` evidence grants NONE. A human MAY convert it into their own `MANAGER_ASSESSMENT` that references it.

---

## L. API contract

No existing request or response shape is broken. All other changes are additive or listed as behavior changes.

| Route | Class | Change |
|---|---|---|
| POST `/api/capability/evidence/[id]/verify` | E, B | Body `action` gains `unverify`, `reopen`, `revoke`, `reinstate`; `verify` and `reject` unchanged in meaning; re-verify idempotent [D10]; ORG_ADMIN may lower [D3] |
| GET `/api/capability/recommendations` | B | Excludes `NOT_ASSESSABLE` [D7] |
| GET `/api/org/capability`, `/api/instructor/capability`, `/[learnerId]` | E | Adds `status`, `confidence` |
| `/api/courses/[id]/skills` (GET, POST, DELETE) | U | |
| `/api/org/roles/**`, `/api/skills` | U, E | Validation unchanged; may add `assessable` |
| `/capability`, `/dashboard`, org and instructor capability pages | E | Confidence, expiry, explanation |
| `/api/ai/copilot`, `/api/ai/org/copilot`, `/api/ai/instructor/copilot` | E, B | Context adds status; prompt must not advise unreachable steps |
| GET `/api/capability/history` | N (30.4) | Own events |
| GET `/api/instructor/capability/[learnerId]/history` | N (30.4) | Owned-evidence scope |
| POST `/api/capability/assessments` | N (30.8, gated) | Assessed-level evidence |
| GET `/api/cron/expire-evidence` | N (30.3) | `CRON_SECRET` |

Classes: U unchanged, E response extension, B behavior change, N new.

---

## M. Invariants (tests MUST assert each)

| ID | Invariant |
|---|---|
| INV1 | `level` is a pure function of (evidence set, policy, asOf); order of evidence does not matter |
| INV2 | Invalid evidence never contributes |
| INV3 | Foreign-tenant or tenant-inconsistent evidence never contributes |
| INV4 | Revoked, superseded, expired and rejected evidence never contributes |
| INV5 | Level is within NONE..EXPERT and never exceeds `maxGrantableLevel(policy)` |
| INV6 | `MET` is never reported when `current < required`; `NOT_ASSESSABLE` is never reported when `required <= maxGrantableLevel` |
| INV7 | Re-processing the same evidence or transition creates no new row and no new event |
| INV8 | Event chain is continuous and `seq` is gap-free per (user, skill) |
| INV9 | Every transition that reaches the projection has exactly one event |
| INV10 | Lowering actions never raise the level; the subject never performs an action on their own evidence |
| INV11 | Removing any one evidence row never raises the level |
| INV12 | `AI_EVALUATION` evidence never changes the level |
| INV13 | Stored `UserSkill` equals a fresh recompute after any interleaving of concurrent transitions on one (user, skill) |
| INV14 | Policy 2 equals policy 1 on every V1-shaped fixture |
| INV15 | Backfill is idempotent |
| INV16 | Confidence is never an input: recomputing with confidence perturbed changes nothing |
| INV17 | `LearningAssignment` code never writes `SkillEvidence` |

**Test constraints:** no property library is installed; use exhaustive enumeration over the finite domain plus fixed-seed permutations unless a library is approved [D18]. Concurrency tests run against the real test database. The existing capability suites (`proficiency`, `verification`, `reconciliation`, `outcomes`, `gaps`, `recommendations`, both reports, the copilot contexts) MUST pass unmodified through S5.

---

## N. Slices

| Slice | Scope | Behavior change |
|---|---|---|
| 30.0 | S0 audit; decides D8 | none |
| 30.1 | Additive schema; pure policy 1 and readiness evaluator with exhaustive tests; composite FKs if approved | none |
| 30.2 | Locked `recomputeUserSkill`; events in-transaction; S2 backfill; shadow and reconciliation | none (V1-equivalent) |
| 30.3 | Policy 2: validity states, verification state machine, authority, expiry cron, confidence | flagged |
| 30.4 | History and audit read endpoints | additive |
| 30.5 | Readiness V2 consumers; `NOT_ASSESSABLE`; recommendation and assignment guard | yes |
| 30.6 | Profile, dashboard, reports, AI contexts show status, confidence, expiry, explanation | additive |
| 30.7 | Analytics data foundation (aggregates and indexes, no UI) | none |
| 30.8 | Assessor path (gated on D2); raises the reachable ceiling | yes |

Order: 30.0 → 30.1 → 30.2 → 30.3 → {30.4, 30.5} → 30.6 → 30.7. 30.8 requires 30.3 and MAY precede 30.6. Hotfix option: guard for `NOT_ASSESSABLE`-equivalent (requirements above INTERMEDIATE) in recommendations and gap assignments before 30.5. [D7]

---

## O. Explicitly out of scope for Phase 30

Numeric or 0-100 canonical proficiency; ML or opaque AI scoring; weighted-sum evidence; hard time decay; tenant-configurable policy, weights or windows; per-role minimum confidence; event sourcing; snapshot tables; readiness-history tables; making `LearningEvent` transactional; learner verification requests and queues; workflow or notifications (Phase 35); skill graphs; a separate mastery concept; tenant columns on `RoleSkill` and `CourseSkill`; dropping deprecated columns; assignment pass marks.

---

## P. Decisions pending approval

`D1` enum and level wording · `D2` assessor path and authority ceilings · `D3` ORG_ADMIN lowering authority · `D4` no hard decay · `D5` 365-day freshness window · `D6` daily expiry cron · `D7` early guard for unreachable requirements · `D8` composite tenant FKs (after audit) · `D9` learner verification request (defer) · `D10` idempotent re-verify · `D11` reserved event types stay un-emitted · `D12` baseline history · `D13` score does not affect level · `D14` deprecated columns retained · `D15` `NOT_ASSESSABLE` semantics · `D16` instructor history scope · `D17` single policy-version constant, no per-tenant config · `D18` property-testing library or enumeration.
