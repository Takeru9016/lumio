# Phase 30 — Capability & Proficiency V2: Contract Discovery

Status: discovery and architecture definition only. No production code, schema, migration, API or UI change accompanies this document.
Companion: `docs/PHASE_30_CAPABILITY_PROFICIENCY_V2_CONTRACT.md` (compact implementation specification).
Written against repository state `2a165ea` (`feat: add learning path experience`), 2026-09-21.

How to read this document. Every statement about V1 is labelled by how it was established:

- **[code]** read directly in the cited file and line.
- **[test]** locked by a named test.
- **[derived]** follows from reading the code but was not reproduced by running it. These are called out because they are the ones most worth re-checking before relying on them.

Every V2 statement is a **proposal** until the decisions in section 30 are approved. Nothing here changes what the system does today.

---

## 1. Executive summary

Lumio's capability loop works and is well guarded at its edges. A trusted learning outcome creates one `SkillEvidence` row through a database unique constraint, `projectUserSkill` recomputes `UserSkill.proficiency` from the full non-rejected evidence set, and role gaps are computed on read. Phases 5, 20, 22, 24 and 25 hardened idempotency, tenant checks and failure isolation, and that work should be preserved.

The model itself is thin, and one defect makes it actively misleading.

**The headline defect: some role requirements can never be met.** `validateRequiredProficiency` accepts `BEGINNER`, `INTERMEDIATE`, `ADVANCED` and `EXPERT` for a `RoleSkill` (`roleManagement.ts:36-50` [code]). `ceilingFor` caps every evidence projection at `INTERMEDIATE` (`proficiency.ts:20-23` [code]). So a role that requires `ADVANCED` or `EXPERT` in any skill is unmet for every learner in every tenant, permanently. The consequences follow through the system [code/derived]:

- `computeCapabilityGap` reports the skill as a gap forever (`gaps.ts:167`).
- `getRecommendedLearning` ranks it as the most severe gap, because severity is ordinal distance (`recommendations.ts:38-40`), until the learner is enrolled in every mapped course, at which point recommendations silently stop while the gap remains (`recommendations.ts:111-119`).
- `createCapabilityGapAssignment` can never take its `GAP_ALREADY_MET` exit for such a skill (`assignments.ts:503`), so an admin can keep creating gap assignments, one per mapped course (bounded by the `[userId, courseId, source, sourceKey]` unique key), each recording "required ADVANCED, current INTERMEDIATE" and none able to close the gap when completed.

Beyond that, V1 has no evidence weighting by type, no use of score, no recency or expiry, no confidence (the column exists and is never written), no history (only `lastAssessedAt`), no audit of verification, and a projection write that is not serialized per learner and skill.

**Recommendation in one paragraph.** Keep the five-level ordinal `SkillProficiency` enum. Keep `UserSkill` as a cache and `SkillEvidence` as the observations. Make the mapping from evidence to level the expressive part: a versioned, table-driven policy that grants a level per evidence (by type and verification), takes the maximum, and can be explained by naming the evidence rows and the rule that produced the level. Add a small set of additive fields (occurrence time, explicit expiry, validity state, revision, normalised score), one append-only `SkillProficiencyEvent` table written inside the projection transaction, and one pure readiness evaluator that replaces the three duplicated comparisons. Expose the currently unreachable levels through a narrow, human-asserted evidence path, and until that exists, report requirements above the reachable ceiling as `NOT_ASSESSABLE` rather than as gaps a learner can close. Prove V1 equivalence on real data before any semantic change is switched on.

**What Phase 30 explicitly does not do:** numeric or ML proficiency, per-tenant weighting or decay configuration, event sourcing, snapshot tables, a workflow engine, or any AI authority over capability state (section 28).

Seven implementation slices are recommended in section 29, with an eighth (assessor path) gated on an approval decision. Eighteen decisions need explicit approval before implementation; they are in section 30.

---

## 2. Current V1 capability contract

### 2.1 Models

| Model | Role | Tenant scope | Key constraints |
|---|---|---|---|
| `Skill` (`schema.prisma:931`) | Tenant skill catalogue. `status` ACTIVE or ARCHIVED. | `tenantId` FK, cascade | `[tenantId, slug]` unique |
| `JobRole` (`:956`) | Tenant role | `tenantId` FK | `[tenantId, slug]` unique |
| `RoleSkill` (`:977`) | Skill required by a role: `requiredProficiency` (default BEGINNER), `isRequired` (default true). This is the "RoleSkillRequirement" of the brief; the model has no such name. | Inherited through `role`; no column | `[roleId, skillId]` unique |
| `UserJobRole` (`:991`) | User holds a role; `isPrimary` | `tenantId` FK | `[userId, roleId]` unique. Nothing limits `isPrimary` to one row per user. |
| `UserSkill` (`:1008`) | **Current-state projection** per learner and skill | `tenantId` FK | `[userId, skillId]` unique (no tenantId in the key) |
| `SkillEvidence` (`:1037`) | Observations that feed the projection | `tenantId` FK | `[tenantId, userId, skillId, sourceType, sourceId]` unique |
| `CourseSkill` (`:1082`) | Skill developed by a course | Inherited through `course`; no column | `[courseId, skillId]` unique |

Enums [code, `schema.prisma:116-146`]: `SkillProficiency` = NONE, BEGINNER, INTERMEDIATE, ADVANCED, EXPERT. `EvidenceType` = COURSE_COMPLETION, QUIZ_SCORE, ASSIGNMENT, ASSESSMENT, PROJECT, MANAGER_ASSESSMENT, CERTIFICATION, AI_EVALUATION, MANUAL. `EvidenceVerificationStatus` = UNVERIFIED, PENDING, VERIFIED, REJECTED. `SkillStatus` = ACTIVE, ARCHIVED.

The level order is hand-written in `PROFICIENCY_ORDER` (`proficiencyOrder.ts:9-15`), deliberately not derived from Prisma enum order.

### 2.2 Skill state

**What is stored on `UserSkill`:** `proficiency` (default NONE), `targetProficiency`, `confidence` (Int), `status`, `lastAssessedAt`, timestamps. Of these, only `proficiency` and `lastAssessedAt` are ever written [code: `proficiency.ts:85-98` is the only writer of the model]. `confidence`, `targetProficiency` and `status` are never written, and `proficiency.test.ts:261` locks that.

**What is stored on `SkillEvidence`:** `type`, free-form `sourceType`/`sourceId`, `proficiency` (never written), `score`, `metadata` (never written), `verificationStatus`, `verifiedById`, `verifiedAt`, `userSkillId` (never written and never read; a dead nullable FK), and `createdAt`/`updatedAt`.

**Authoritative for current proficiency:** `UserSkill.proficiency`, as a **derived cache**. It is mutable only through `projectUserSkill`, which recomputes it in full from the evidence set. It is therefore "both": stored, but always a pure function of evidence at the time of the last write [code: `proficiency.ts:58-99`].

**Ceilings** [code: `proficiency.ts:20-23`]: each non-rejected evidence row contributes a ceiling of `BEGINNER` (UNVERIFIED or PENDING) or `INTERMEDIATE` (VERIFIED). The projection is `maxProficiency` over those ceilings, or `NONE` if there are none. The evidence type, the score and the source are ignored.

**Multiple evidence rows:** the maximum ceiling wins. Ten unverified completions give `BEGINNER`; two verified rows give `INTERMEDIATE`. There is no accumulation.

**`lastAssessedAt`:** set only when the projected value changes, or on first creation (`proficiency.ts:79-83`). It is the time of the last *level change*, not of the last evidence. It is fed the outcome's own timestamp when evidence creates it and `new Date()` when verification does.

### 2.3 Evidence sources

Exactly three evidence types have a production writer. All rows are written by `recordSkillEvidenceOutcome` (`outcomes.ts:31-65`) in one transaction per skill with the projection, created `UNVERIFIED`. It never sets `createdAt`, so `createdAt` is the database write time, not the time of the event.

| | COURSE_COMPLETION | QUIZ_SCORE | ASSESSMENT |
|---|---|---|---|
| sourceType / sourceId | `"Course"` / `Course.id` | `"Quiz"` / `Quiz.id` since Phase 25; historical rows `"QuizAttempt"` / attempt id | `"AssignmentSubmission"` / submission id |
| Creation path | `recordCourseCompletionEvidence` (`outcomes.ts:155-230`), called by the lesson-complete route on the request that wins the enrollment transition (`complete/route.ts:141-158`), by `reconcileCourseCompletionEvidence` (`reconciliation.ts:46-75`) on later requests, and by `addCourseSkill` backfill (`courseSkillManagement.ts:131-142`) | `recordQuizOutcome` (`outcomes.ts:360-444`), called by the attempt route after the attempt commits (`attempt/route.ts:181-190`), pass only | `recordAssignmentGradeOutcome` (`outcomes.ts:469-534`), called by the grade route (`grade/route.ts:101-111`) |
| Update path | Verification fields only. | Verification fields only. The row keeps the score of the first passing attempt; later passes hit P2002 and are no-ops (`outcomes.test.ts:288,451`). | Verification fields only. A regrade is a no-op even when it lowers the score (`outcomes.test.ts:756,793`). |
| Contribution | BEGINNER unverified, INTERMEDIATE verified | same | same |
| Can raise | Yes | Yes, on a pass only | Yes, on any graded score, including 0 (`outcomes.test.ts:647`) |
| Can lower | Only by being REJECTED | same | same |
| Verified at creation | No (UNVERIFIED) | No | No |
| Expires or goes stale | Never | Never | Never |
| Tenant scoped | Yes: row `tenantId`; course tenant asserted (`assertSameTenant`); cross-tenant `CourseSkill` mappings skipped (`outcomes.ts:76-98`) | Yes, same | Yes, same |
| Immutable | All but the verification fields and `updatedAt`. No delete path exists in the application. | same | same |
| `score` stored | none | quiz percentage 0-100, first pass | raw points 0-`maxScore`; `maxScore` is not stored on the evidence |

**Unused evidence types** [code]: `ASSIGNMENT`, `PROJECT`, `MANAGER_ASSESSMENT`, `CERTIFICATION`, `AI_EVALUATION` and `MANUAL` have no writer anywhere. Because `ceilingFor` ignores type, a row of any of these would project exactly like the three above. Note that graded assignments write `ASSESSMENT`, never `ASSIGNMENT` (`outcomes.ts:496`).

**Unused verification state** [code]: `PENDING` is never created. There is no learner-initiated "request verification". `ceilingFor` still handles it explicitly as `BEGINNER` (`proficiency.ts:11-15`, `proficiency.test.ts:91`).

### 2.4 Progression today

```
no non-rejected evidence          -> NONE
any non-rejected evidence         -> BEGINNER       (a completion, a passed quiz, or a graded assignment of any score)
any VERIFIED non-rejected evidence-> INTERMEDIATE   (an authorised human clicked verify)
ADVANCED, EXPERT                  -> unreachable
```

Levels exist as an enum and as the value of `requiredProficiency`, but only three of the five can ever be a learner's projection. Regression exists only through rejection: rejecting the last supporting row recomputes downward, to `NONE` if nothing remains (`verification.test.ts:325-431`).

### 2.5 Role readiness today

`UserSkill -> RoleSkill -> gap` [code: `gaps.ts:22-36, 142-172`]:

1. Requirements are `RoleSkill` rows with `isRequired: true` and `skill.status = ACTIVE`, for a role inside the caller's tenant.
2. Current proficiency is the learner's `UserSkill.proficiency`, or `NONE` if no row exists.
3. `met = compareProficiency(required, current) <= 0`.

There is **no role-level verdict** in V1: no "is this learner ready for this role". Each consumer receives a list of per-skill `met` flags. The comparison is implemented three times, all equal today: `gaps.ts:167`, `organizationReport.ts:247` and `instructorReport.ts:262,366`. The recommendation severity (`recommendations.ts:38-40`) and the gap-assignment snapshot (`assignments.ts:497-524`) read the same values.

### 2.6 Existing guarantees

| Guarantee | Current mechanism | Where |
|---|---|---|
| Evidence uniqueness | DB unique `[tenantId, userId, skillId, sourceType, sourceId]`; P2002 is a benign no-op | `outcomes.ts:59-64`; migration `20260911000000` |
| Atomic evidence + projection | One `$transaction` per skill | `outcomes.ts:43-57` |
| One skill's failure does not block another | Per-skill transactions; aggregate `CourseCompletionEvidenceError` after all are attempted | `outcomes.ts:126-140, 205-227` |
| Completion evidence is durable | Write first in its own failure boundary; reconcile on every later completion request; backfill on new `CourseSkill` | `complete/route.ts:96-196`, `reconciliation.ts` |
| Quiz outcome cannot break the attempt | Best-effort; never throws | `outcomes.ts:360-444` |
| Exactly-once completion side effects | Atomic conditional `updateMany` on the enrollment status | `complete/route.ts:126-131` |
| Attempt cap | `FOR UPDATE` on the learner's enrollment | `attempt/route.ts` (locking block) |
| Tenant checks at write | `assertSameTenant` on the course; mapped skill's tenant filtered | `outcomes.ts:76-98,167` |
| Tenant checks at read | Every capability read filters `tenantId`; reports filter `deletedAt: null` | `evidence.ts:25-38`, `organizationReport.ts:118` |
| Verification authorisation | Not the subject; same tenant; source must resolve to a course (fail closed); then SUPER_ADMIN or the course-owning INSTRUCTOR. ORG_ADMIN is excluded by design. | `verification.ts:146-174, 254-258` |
| Recompute is order-independent | Full recompute, `maxProficiency` | `proficiency.ts`; `proficiency.test.ts:168` |
| Audit | None for capability transitions. `LearningEvent` records COURSE_COMPLETED, QUIZ_COMPLETED and ASSIGNMENT_GRADED only, best-effort and outside the transaction. `AdminAuditLog` covers platform actions only. | `emit.ts:14-23`, `admin-audit.ts` |
| Row locks on the projection | **None.** Locks exist elsewhere (enrollment rows, the tenant row for prerequisites) but not on `UserSkill`. | `proficiency.ts` |

### 2.7 Current API surface (from the route files, since `docs/API.md` has no capability content)

| Route | Methods | Audience |
|---|---|---|
| `/api/capability/evidence/[evidenceId]/verify` | POST `{action: verify or reject}` | INSTRUCTOR (owner), SUPER_ADMIN |
| `/api/capability/recommendations` | GET (`?roleId`) | any tenant user, self |
| `/api/org/capability` | GET | ORG_ADMIN |
| `/api/instructor/capability`, `/[learnerId]` | GET | INSTRUCTOR |
| `/api/courses/[courseId]/skills`, `/[skillId]` | GET, POST; DELETE | INSTRUCTOR (owner), ORG_ADMIN |
| `/api/org/roles`, `/[roleId]`, `/[roleId]/skills`, `/[roleId]/skills/[skillId]`, `/[roleId]/users`, `/[roleId]/users/[userId]` | GET, POST; GET, PATCH, DELETE; POST; PATCH, DELETE; POST; PATCH, DELETE | ORG_ADMIN |
| `/api/skills` | GET, POST | GET is a tenant-scoped read; POST is ORG_ADMIN |
| Server-composed pages and AI routes reading the domain | `/capability`, `/dashboard`, `/org/capability`, `/instructor/capability`, `/api/ai/copilot`, `/api/ai/org/copilot`, `/api/ai/instructor/copilot` | |

---

## 3. Problems and gaps in V1

Ordered by severity. IDs are referenced elsewhere.

| ID | Severity | Finding | Basis |
|---|---|---|---|
| G1 | **High** | Roles may require ADVANCED and EXPERT; nothing can produce them. Those requirements are permanently unmet, are recommended at maximum severity, and generate gap assignments that cannot close the gap (section 1). | [code] |
| G2 | Medium | The projection write is not serialized per (learner, skill). Two transactions that change different evidence rows for the same skill each recompute from a snapshot that excludes the other's uncommitted change, and the later `UserSkill` upsert overwrites the earlier with a value derived from stale data. Example: verify row A while rejecting or creating row B; the final level depends on commit order, not on the evidence. No test covers concurrent verify/create on different rows. | [derived] |
| G3 | Medium | No history or audit. Verification leaves only `verifiedById`/`verifiedAt`, which a second verify overwrites (`verification.ts:194-200`), and which a reject leaves in place. A level change leaves only `lastAssessedAt`. "Why is my level INTERMEDIATE, who changed it, when" is unanswerable. | [code] |
| G4 | Medium | Time semantics are unreliable. `SkillEvidence.createdAt` is write time, not occurrence time, so evidence created by reconciliation or backfill is dated when reconciled, not when the course was completed. `lastAssessedAt` means "last level change", not "last assessment". | [code] |
| G5 | Medium | `score` has no effect and is not comparable. A 71% and a 100% quiz pass project identically. Quiz scores are 0-100; assignment scores are raw points and the `maxScore` is not on the evidence (it is on the mutable `Assignment` and in the `LearningEvent` metadata). A graded 0 still creates evidence. The stored score is the first qualifying event, not the best or latest. | [code][test] |
| G6 | Medium | `BEGINNER` means "any non-rejected evidence exists" and `INTERMEDIATE` means "a human verified something". Every INTERMEDIATE requirement in every tenant therefore depends on an instructor who owns the source course (or SUPER_ADMIN) taking an action the learner cannot request. Nobody else, including ORG_ADMIN, can verify. | [code] |
| G7 | Low-Medium | Verification transitions are unconstrained. `setEvidenceVerificationStatus` has no precondition on the current status, so REJECTED to VERIFIED and VERIFIED to REJECTED both work; re-verifying overwrites the verifier; there is no way to return VERIFIED to UNVERIFIED; ORG_ADMIN cannot even reject; a soft-deleted learner is not checked. | [code] |
| G8 | Low | Dead schema and vocabulary: `UserSkill.confidence`, `targetProficiency`, `status`; `SkillEvidence.userSkillId`, `proficiency`, `metadata`; six unused evidence types; `PENDING`; the `SKILL_ASSESSED` and `SKILL_EVIDENCE_CREATED` event types (declared, never emitted). | [code] |
| G9 | Low | Readiness comparison is triplicated and there is no role-level verdict (section 2.5). | [code] |
| G10 | Low | Tenant consistency is by convention. No database constraint ties `SkillEvidence`/`UserSkill` `tenantId` to the user's or skill's tenant; `RoleSkill` and `CourseSkill` carry no tenant, so consistency is checked at write (`roleManagement.ts:234-240`) or filtered at read (`outcomes.ts:76-98`). | [code] |
| G11 | Low | Evidence whose source disappears keeps contributing but can never be verified: `resolveSourceCourse` returns null and verification fails closed. | [code] |
| G12 | Info | "Course completion revoked" is not reachable today: `REFUNDED` enrollments have no production writer (only tests), and no path reverts a COMPLETED enrollment. | [code] |
| G13 | Info | Documentation drift: `docs/SCHEMA.md`, `docs/API.md`, `docs/STACK.md` and `docs/DESIGN_SYSTEM.md` contain no capability content, and `docs/V2_ROADMAP.md` records capability work only through Phase 13. The code and its tests are the only current authority, which is why this discovery was traced from them. | [code] |

Two of these are worth stating as things V1 **does right**, so V2 does not regress them: the Phase 24 durability guarantee (completion, then `CourseSkill`, then evidence, reconciled on every path) and the Phase 25 quiz identity (one row per learner, quiz and skill, however many passes).

---

## 4. V2 design principles

1. **Evidence is the truth; proficiency is a cache.** `UserSkill` must always equal a pure function of (valid evidence set, policy version, evaluation time). It can be dropped and rebuilt.
2. **Deterministic and explainable.** Every level is explained by naming the evidence rows and the row in a policy table that granted the level. No numeric blending, no learned weights.
3. **Ordinal, not numeric.** Keep five levels. Expressiveness lives in the evidence-to-level mapping.
4. **Raising needs an independent, accountable source. Lowering may be wider.** A level is raised only by a trusted system outcome or a human who is not the learner. Actions that can only lower capability (reject, un-verify, revoke) may be taken by a wider set of actors, and must work even when the evidence's source no longer exists.
5. **Never delete evidence.** Invalid evidence is excluded from calculation and stays visible, with who and why.
6. **One transaction for the truth, best-effort for the side streams.** Evidence transition, projection change and history event commit together. `LearningEvent` and notifications stay best-effort and are never the source of truth.
7. **One readiness evaluator.** A single pure function, used by every consumer.
8. **Additive, versioned, reconcilable.** V1 equivalence is proven on real data before any semantic change is enabled, behind one server-side policy-version constant.
9. **AI consumes; the domain decides.**
10. **Tenant isolation is enforced in the database where it is cheap and at runtime where it is not, and no source reference is trusted.**

---

## 5. Canonical proficiency model

### 5.1 Retain the five-level ordinal enum

Alternatives evaluated:

| Option | Verdict |
|---|---|
| Keep NONE / BEGINNER / INTERMEDIATE / ADVANCED / EXPERT | **Keep.** Already understood by learners, instructors and admins; it is the value of `RoleSkill.requiredProficiency`, of `PROFICIENCY_ORDER`, `isAtLeast`, `compareProficiency`, the recommendation severity sort, the `LearningAssignment.reason` JSON snapshots already persisted in rows, the AI prompt text, and four UI surfaces. |
| Numeric 0-100 canonical score | **Reject.** A breaking change at every one of those consumers; `requiredProficiency` comparisons become ill-defined ("is 62 enough?"); creates false precision from three coarse evidence types; and must still be mapped back to labels for people. |
| Normalised score alongside the level | **Reject as canonical; adopt narrowly.** Store a `scorePercent` on evidence so scores become comparable and available to analytics (section 24). It never feeds the level in Phase 30. |
| Confidence-adjusted level (a single blended value) | **Reject.** Hides why. Confidence is a separate derived qualifier (section 9). |
| Separate mastery and proficiency | **Reject.** No user-facing reason (section 15). |

Proposed user-facing definitions (product wording requires approval, decision D1):

| Level | Meaning to a learner |
|---|---|
| NONE | No valid evidence of this skill yet |
| BEGINNER | You have taken part in learning tied to this skill |
| INTERMEDIATE | A qualified person has confirmed your evidence |
| ADVANCED | A qualified person has assessed you as skilled in this area |
| EXPERT | A qualified person has assessed you as able to lead or teach this area |

The definition of INTERMEDIATE and below matches V1 behavior exactly. ADVANCED and EXPERT are defined as human-assessed levels, which is what makes them reachable without inventing an automatic accumulation rule (section 10).

### 5.2 Canonical state

- **`SkillEvidence`** = observations, each with a validity state and a verification status. It is the source of truth.
- **`UserSkill`** = the current-state projection of one learner and skill. It keeps `proficiency` and `lastAssessedAt` with their present meaning and gains derived fields (section 5.3).
- **`SkillProficiencyEvent`** (new, section 14) = the append-only record of every projection-affecting transition.

No further model is required. In particular there is no `SkillLevel` table, no gap table and no snapshot table.

### 5.3 Additive fields

```
SkillEvidence   + occurredAt    DateTime?   when the underlying event happened (backfilled; then required)
                + validUntil    DateTime?   explicit expiry; null = does not expire
                + state         EvidenceState @default(ACTIVE)   ACTIVE | SUPERSEDED | EXPIRED | REVOKED
                + revision      Int @default(0)                  incremented on every transition (optimistic guard + event idempotency)
                + scorePercent  Float?      0-100 normalised snapshot; null when not applicable or unknown
                (assessor slice) + assessedLevel SkillProficiency?, + supersededById String?
UserSkill       + evidenceConfidence EvidenceConfidence?   derived, LOW | MEDIUM | HIGH; null at NONE
                + eventSeq      Int @default(0)            per-(user, skill) event counter, assigned under the row lock
                + policyVersion Int?                       policy that produced the current projection
```

Existing `UserSkill.confidence` (Int), `targetProficiency`, `status` and `SkillEvidence.userSkillId`, `proficiency`, `metadata` are left in place and deprecated, not dropped (section 20).

---

## 6. Evidence model

### 6.1 Three separate questions

The brief requires these not be conflated. V2 defines them separately and computes them separately.

| Question | Definition | Where it lives |
|---|---|---|
| **Exists** | A `SkillEvidence` row is present, in any state. | The row |
| **Valid** | `state = ACTIVE`, `verificationStatus != REJECTED`, `validUntil` null or in the future, and the row is tenant-consistent (row, learner and skill share one tenant). | Pure function `isValid(evidence, asOf)` |
| **Contributes** | Valid, and its policy grant is above NONE. | Pure function `grant(evidence)` |

Only "contributes" affects proficiency. "Exists" is always visible to the learner and to authorised reviewers; "valid" drives the explanation ("this evidence expired on ...").

### 6.2 Two classes of evidence

| Class | Types | Created by | Ceiling |
|---|---|---|---|
| **Activity evidence** | COURSE_COMPLETION, QUIZ_SCORE, ASSESSMENT (graded assignment) | A trusted system outcome (V1 writers, unchanged) | BEGINNER unverified; INTERMEDIATE verified. Identical to V1. |
| **Assessed-level evidence** | MANAGER_ASSESSMENT, CERTIFICATION (and PROJECT, reserved) | A named human assessor who is not the learner | The level the assessor asserts (`assessedLevel`), capped by the assessor's authority. Verified by construction. |

Types with no writer or authority today (`ASSIGNMENT`, `MANUAL`, `AI_EVALUATION`) are reserved and grant nothing (section 7, section 25).

### 6.3 Identity and immutability

- Source identity stays `(sourceType, sourceId)` inside the existing unique key. That key remains the concurrency guarantee. It is not changed.
- An observation is immutable in what it says (`type`, `sourceType`, `sourceId`, `score`, `scorePercent`, `occurredAt`, `assessedLevel`). What can change is its **standing**: `verificationStatus` and `state`, both audited. This preserves V1's "first evidence wins" for scores (section 17).
- No application path deletes evidence. The only deletions are the existing FK cascades from tenant, user and skill, which are required for erasure.

---

## 7. Evidence weighting

**Decision: grant-and-maximum, not weighted sum.** Each valid evidence row grants a level from a fixed table; the projection is the maximum grant. Numeric weights are rejected: the three current sources have no common scale (G5), a weighted sum cannot be explained in one sentence to a learner, and every invariant test would depend on weight arithmetic. The V1 rule ("strongest evidence") is kept; only the table becomes richer.

### 7.1 Policy table

Policy version 1 reproduces V1 exactly (type-agnostic). Policy version 2 is the target.

| Evidence | Unverified / Pending | Verified | Maximum reachable | Verification changes weight? | Recency changes weight? |
|---|---|---|---|---|---|
| COURSE_COMPLETION | BEGINNER | INTERMEDIATE | INTERMEDIATE | Yes, one level | No (explicit expiry only) |
| QUIZ_SCORE (pass) | BEGINNER | INTERMEDIATE | INTERMEDIATE | Yes | No |
| ASSESSMENT (graded assignment) | BEGINNER | INTERMEDIATE | INTERMEDIATE | Yes | No |
| MANAGER_ASSESSMENT | (not created unverified) | `assessedLevel`, capped by assessor authority | EXPERT | Verified by construction | Only if `validUntil` set |
| CERTIFICATION | (not created unverified) | `assessedLevel` as recorded by the verifying human, capped at ADVANCED | ADVANCED | Verified by construction | Yes: explicit `validUntil` is expected |
| PROJECT | reserved: NONE | reserved | - | - | - |
| ASSIGNMENT | reserved: NONE | reserved | - | - | - |
| MANUAL | reserved: NONE | reserved | - | - | - |
| AI_EVALUATION | **NONE** | **NONE** | - | A human converting it creates a separate MANAGER_ASSESSMENT that references it; the AI row itself never contributes | - |

Equivalence argument: on production data the three activity types are the only types present and `state = ACTIVE`, `validUntil = null` for all rows, so policy 2 produces the same output as policy 1 by construction. The pre-flight audit (section 21) turns that argument into a checked fact by counting rows of the reserved types (expected 0) and any `PENDING` rows (expected 0).

### 7.2 Base contribution, maximum contribution, confidence

- **Base contribution:** the unverified grant.
- **Maximum contribution:** the verified grant, or `assessedLevel` for assessed-level evidence.
- **Confidence contribution:** verified or assessed evidence supports HIGH confidence if fresh; the rules are in section 9.
- **Score:** does not change the grant in Phase 30. It is recorded normalised for analytics. Introducing score-banded grants requires a documented pass mark for assignments, which the schema does not have (`Assignment` has `maxScore` but no `passingScore`), and is deferred (decision D13).

### 7.3 Per-source notes the brief asked about

| Source | Note |
|---|---|
| Course completion | Grants BEGINNER on completion because completing the course is the evidence. Verified: INTERMEDIATE. No decay. |
| Quiz | Pass only. Failing has no capability effect (V1 preserved). |
| Assignments | Graded assignment evidence grants as in V1. Being *assigned* is not evidence (section 18). |
| Verified evidence | Verification lifts activity evidence by exactly one step and changes confidence. |
| Manual verification | The action, not a type. Section 12. |
| Practical assessments, instructor assessment | Assessed-level path (section 12.3, slice 30.8). |
| External credentials | CERTIFICATION with `validUntil`. A person records and verifies it; the system never trusts an external claim unverified. |
| AI-generated assessment | Contributes nothing on its own (section 25). |

---

## 8. Evidence recency and staleness

### 8.1 Decisions

| Question | Decision |
|---|---|
| Does all evidence decay? | **No.** Hard time decay of activity evidence is rejected for Phase 30 (D4). A learner who completed a course does not silently lose the capability after a fixed interval without any evidence that it was lost. |
| Which evidence expires? | Only evidence with an explicit `validUntil`: CERTIFICATION (expected) and assessed-level evidence where the assessor sets one. Expiry is a hard boundary: past `validUntil`, the row does not contribute. |
| Is there a default window? | Two separate ideas. **Expiry**: none by default. **Freshness window**: 365 days, used **only** for the confidence qualifier and a "review due" signal, never to change the level or readiness (D5). |
| Tenant-configurable? | **No** in Phase 30. The window and policy are code constants versioned by `policyVersion`. Rejected for now: no tenant has asked, and it would make every invariant tenant-parameterised (section 28). |
| Does stale evidence remain visible? | Yes, always, with its age and state. |
| Does stale (aged, unexpired) evidence contribute to proficiency? | **Yes.** Aged is not invalid. |
| Does stale evidence affect role readiness? | **No.** Only the confidence qualifier changes ("met, low confidence, evidence 14 months old"). |
| Does verified evidence expire? | Verification has no lifetime of its own. It expires with the evidence's `validUntil`. |
| Can certifications have explicit expiry? | Yes: `validUntil`. |

### 8.2 The consequence of time-driven validity

Expiry is a change in validity that happens with no write. A cached projection would then be wrong until something recomputes it. The proposal is a daily cron (the repository already runs two, in `vercel.json`) that selects `state = ACTIVE AND validUntil <= now`, marks each `EXPIRED` (revision bump), re-projects the affected (user, skill), and appends an `EVIDENCE_EXPIRED` event. Maximum lag is the cron interval (D6). It must be per-key isolated and idempotent, following the Phase 25 pattern: one failing learner does not block the rest, and re-running is safe.

Reading the projection between expiry and the cron is accepted as a lag of at most a day. A read-time "as of now" recompute was rejected because it would move cost onto every capability read for a case that affects only evidence with an explicit expiry.

### 8.3 Why not decay now

Decay is the one V2 rule whose correct parameters cannot be known without data. The history events introduced in slice 30.2 will show how levels actually age. The recommendation is to measure first and decide in a later phase, using the freshness signal as the measurement instrument.

---

## 9. Confidence

Confidence does not exist in V1 (G8); `UserSkill.confidence` is never written. V2 introduces it as a **derived, categorical** qualifier of the projected level, never an input.

### 9.1 Definition

```
supporting = valid evidence whose grant equals the projected level
fresh(e)   = now - e.occurredAt <= 365 days     (or e.validUntil in the future, when set)

NONE level                                     -> null
HIGH   : supporting contains a VERIFIED or assessed row that is fresh
MEDIUM : supporting contains a VERIFIED or assessed row that is not fresh
         OR supporting has UNVERIFIED rows of >= 2 different evidence types
LOW    : otherwise (a single unverified type, or unverified and aged)
```

### 9.2 Properties

- **Derived, deterministic, stored as a cache** in `UserSkill.evidenceConfidence` so reports can filter on it, and recomputed by the same function as the level. It cannot be set by any request, by AI or by an admin.
- **Categorical, three values.** A number invites false precision. The three values map to statements a person can read: "verified and recent", "verified but old, or independently corroborated", "single unverified source".
- **Corroboration counts evidence types, not source ids.** Counting raw source ids would treat V1's historical per-attempt quiz rows as independent sources (Phase 25 note in `outcomes.ts:296-308`). Types avoid the legacy problem.
- **It qualifies; it does not gate.** Role readiness `MET` is decided by level alone. Per-role minimum-confidence requirements are rejected for now (section 28).
- The existing Int column is deprecated and not reused, to avoid changing the meaning of a column that some future reader might assume is a number.

---

## 10. Progression

**Rule: the strongest valid grant.**

```
valid(e, asOf)  := e.state = ACTIVE
                   AND e.verificationStatus != REJECTED
                   AND (e.validUntil IS NULL OR e.validUntil > asOf)
                   AND e.tenantId = learner.tenantId = skill.tenantId
level(evidence, policy, asOf) := max( NONE, max{ grant(policy, e) | valid(e, asOf) } )
```

Alternatives considered:

| Approach | Verdict |
|---|---|
| Strongest evidence (max) | **Keep.** It is V1, order-independent, idempotent, and explainable. |
| Weighted aggregate | Reject (section 7). |
| Threshold accumulation ("N completions gives INTERMEDIATE") | Reject. It rewards volume of unverified evidence, is trivially gamed, and makes "why" a count. |
| Rolling score | Reject. Opaque, and needs decay parameters no data supports. |
| Minimum count of independent evidence | Reject for the level. It is used, narrowly, for the MEDIUM confidence rule. |

**How ADVANCED and EXPERT are reached.** Not by accumulating activity. They are reached by assessed-level evidence: a person who is not the learner, with authority, records an assessment. Recommended authority ceilings (D2): the course-owning INSTRUCTOR up to ADVANCED for learners enrolled in their course; ORG_ADMIN in the same tenant up to EXPERT. This is the smallest change that makes the top of the scale real without inventing an automatic rule, and it matches how the top of a scale is normally attested. It is also the only part of Phase 30 that adds a new write path; it is therefore isolated as slice 30.8 and gated on approval.

Until slice 30.8 ships, the top two levels remain unreachable, which is why slice 30.5 introduces `NOT_ASSESSABLE` (section 19) and the interim decision D7 exists.

---

## 11. Regression

**Current proficiency is a cache that changes whenever the valid evidence set changes.** It is never decremented directly. Every regression is a recalculation.

| Cause | V1 | V2 |
|---|---|---|
| Evidence rejected | Yes | Yes (verification set, and ORG_ADMIN per D3) |
| Verification revoked (VERIFIED to UNVERIFIED) | No such action | Yes: the level drops by the verification step |
| Evidence expired (`validUntil`) | No concept | Yes, by cron |
| Evidence superseded by a newer assessed-level assertion (which may be lower) | No concept | Yes: a lower reassessment lowers the level |
| Evidence administratively revoked (error correction, integrity) | No concept | Yes |
| Time decay of activity evidence | No | **No** (D4) |
| Failed reassessment (quiz fail after pass) | No effect | **No effect.** A failed attempt records an outcome, not negative evidence. Preserved deliberately: no product requirement defines what negative evidence would mean. |
| Explicit manager decision "set to X" | No | **No direct set, ever.** A manager creates assessed-level evidence; the projection follows. |

Regression events are first-class in history (section 14), each with its actor and reason. Because the projection is a pure function, there is no path by which a stale higher value can be remembered.

---

## 12. Verification

### 12.1 Who may do what

Principle 4 (raising needs independence, lowering may be wider) yields this table. Rows marked **V1** exist today; the rest are proposed.

| Action | Transition | Actors | Notes |
|---|---|---|---|
| verify | UNVERIFIED, PENDING, REJECTED to VERIFIED | Course-owning INSTRUCTOR; SUPER_ADMIN (tenant-bound, source must resolve) **[V1]** | Never the learner. Never cross-tenant. ORG_ADMIN is not added (see below). |
| reject | UNVERIFIED, PENDING, VERIFIED to REJECTED | The verify set **[V1]**, plus ORG_ADMIN in the same tenant (D3) | Lowering. Works when the source no longer resolves. |
| un-verify | VERIFIED to UNVERIFIED | verify set plus ORG_ADMIN (D3) | New. Clears `verifiedById`/`verifiedAt`; the event keeps the actor. |
| reopen | REJECTED to UNVERIFIED | verify set | New. |
| request | UNVERIFIED to PENDING | The learner only | Optional; deferred (D9). |
| revoke | state ACTIVE to REVOKED | ORG_ADMIN, SUPER_ADMIN, reason required; system integrity check | New. Administrative correction. |
| reinstate | state REVOKED to ACTIVE | ORG_ADMIN, SUPER_ADMIN, reason required | New. |

**Why ORG_ADMIN is not added to `verify`.** Phase 20 deliberately excluded ORG_ADMIN from verification (`verification.ts:236-258`), and the reason is coherent: verification confirms that evidence produced by a specific course genuinely demonstrates the skill, and the course's own instructor is the person who can say so. ORG_ADMIN authority over capability belongs in the assessed-level path (section 10), where they assert a level rather than vouch for someone else's evidence. There is no manager role in the data model (`Team`/`TeamMember` carry no role), so "manager verification" cannot be built as a distinct authority without one; the brief's manager-facing questions are answered by ORG_ADMIN and INSTRUCTOR.

### 12.2 Effects

| Question | Answer |
|---|---|
| Tenant scoped? | Yes, unchanged. |
| Does verification change proficiency? | Yes: one step, through the policy table. |
| Does it change confidence? | Yes: verified is required for HIGH and MEDIUM-by-verification. |
| Audit event? | **Yes, new.** Every transition writes a `SkillProficiencyEvent` in the same transaction with actor and reason. V1 writes none. |
| Reversible? | Yes: un-verify, reopen, reinstate. |
| Concurrency | Transitions are compare-and-swap on `revision`; the projection is recomputed under a `UserSkill` row lock (section 21.3). Idempotent: re-verifying an already VERIFIED row is a no-op that keeps the original verifier (a small V1 behavior change, D10). |
| Dependent role readiness | Recomputed in the same transaction. Readiness is computed on read from the projection, so it is consistent as soon as the transaction commits. |
| Subject-independence | Never the subject. Soft-deleted learner refused. |

### 12.3 Assessed-level evidence (slice 30.8, gated)

One narrow write path, not a workflow: an authorised assessor records `{skillId, learnerId, assessedLevel, validUntil?, note}`, which creates one `MANAGER_ASSESSMENT` (or `CERTIFICATION`) row, `VERIFIED` by the assessor, and supersedes any earlier assessed-level row for the same learner and skill. No queue, no approval chain, no notifications. Those are Phase 35.

---

## 13. Invalidation and revocation

Evidence is never deleted. Its standing is expressed in two fields with distinct meanings:

- `verificationStatus = REJECTED`: a human judged that this evidence does not demonstrate the skill (V1 meaning, kept).
- `state`: whether the row is still in force at all.

| Situation | Treatment |
|---|---|
| Course completion revoked | No production path today (G12). If one is added, it must call `revoke` with a reason; the projection follows. |
| Quiz evidence superseded | Not applicable: quiz evidence is one row per quiz and skill and is never superseded (section 17). |
| Manual verification revoked | `un-verify` (VERIFIED to UNVERIFIED) or `reject`. |
| Assignment evidence withdrawn | `revoke` with a reason. |
| Certification expires | `state = EXPIRED` by cron once `validUntil` passes. |
| Assessed-level evidence replaced | `state = SUPERSEDED` and `supersededById` set, in the same transaction as the new assessment. |
| **Source record deleted** | **Evidence is retained and still contributes.** It is historical fact (the same rule Phase 22 applies to removing a `CourseSkill`). It remains unverifiable (fail closed) but a lowering action by ORG_ADMIN works without resolving the source. Auto-revoking on source deletion is rejected: ordinary content housekeeping must not silently regress capability. |
| **Source belongs to a foreign or invalid tenant** | **Never contributes.** `valid()` requires the row, learner and skill to share one tenant; a mismatch is excluded from calculation and flagged by the integrity check. |
| Skill archived | Projection and evidence retained; the skill leaves readiness (V1 behavior); recalculation continues so a later un-archive is correct. |
| Learner soft-deleted (`deletedAt`) | Evidence and events retained; excluded from reports (V1); verification refused. |

Every state change is one transaction: evidence update (guarded by `revision`), projection recompute under lock, history event. The invariants for this are in the contract file.

---

## 14. Proficiency history

### 14.1 Decision: one append-only event table, no snapshots

`SkillProficiencyEvent` records **every evidence transition that reaches the projection**, including those that leave the level unchanged. This one table serves both needs: proficiency history and the verification audit trail, which are otherwise two overlapping systems.

Rejected: snapshots (no query needs them; events answer all seven questions below), canonical event sourcing (the projection already works and is order-independent; replaying events to derive state is a large rewrite for no requirement), and reusing `LearningEvent` (section 23.2).

### 14.2 Shape

```
SkillProficiencyEvent
  id, tenantId, userId, skillId                    (FK cascades as for UserSkill)
  seq             Int        per-(user, skill) sequence, assigned under the UserSkill row lock
  cause           enum       BASELINE | EVIDENCE_ADDED | EVIDENCE_VERIFIED | VERIFICATION_REVOKED | EVIDENCE_REJECTED
                             | EVIDENCE_REOPENED | EVIDENCE_EXPIRED | EVIDENCE_SUPERSEDED | EVIDENCE_REVOKED
                             | EVIDENCE_REINSTATED | RECALCULATED
  evidenceId      String?    the evidence acted on (SetNull); null for BASELINE, RECALCULATED
  evidenceRevision Int?      the revision this transition produced
  actorId         String?    null when the system acted (SetNull)
  actorRole       Role?      snapshot of the actor's role at the time
  reason          String?    short, required for revoke/reinstate
  previousProficiency SkillProficiency?   null for the first event
  newProficiency      SkillProficiency
  previousConfidence  EvidenceConfidence?
  newConfidence       EvidenceConfidence?
  policyVersion   Int
  contributing    Json       [{evidenceId, type, verificationStatus, grant}] for the NEW state (ids and enums only)
  occurredAt      DateTime   business time of the cause (a backfilled completion is dated when it happened)
  recordedAt      DateTime   @default(now())   when it was recorded

  unique [userId, skillId, seq]          total order per learner and skill
  unique [evidenceId, evidenceRevision]  one event per evidence transition (idempotency); nulls distinct
  index  [tenantId, skillId, recordedAt], [tenantId, userId, skillId, recordedAt], [tenantId, cause, recordedAt]
```

### 14.3 Timestamp semantics

- `recordedAt` is the ordering and "as of" clock. "What was my level 30 days ago" is the last event with `recordedAt <= T`.
- `occurredAt` is business time and can be backdated. Growth analytics that ask "when was the capability earned" use it.
- Order within one learner and skill is `seq`, not either timestamp. The chain invariant (each event's `previous` equals the prior event's `new`) is directly testable.

### 14.4 The seven questions

| Question | Answered by |
|---|---|
| Level now | `UserSkill.proficiency` |
| Level 30 days ago | Last event with `recordedAt <= T`; `newProficiency` |
| Why did it change | `cause`, `reason`, `contributing` |
| Which evidence caused it | `evidenceId`, `contributing` |
| Improved or regressed | `newProficiency` vs `previousProficiency` (ordinal) |
| When did I become role-ready | For each current requirement, the first event whose `newProficiency` reached the required level and stayed there; the role-level time is the latest of those. **Computed against the current requirements**, since requirement history is not stored. Stated limitation. |
| Which skills are trending down | Events in a window where the ordinal decreased |

### 14.5 Pre-V2 history is not reconstructible

`lastAssessedAt` is the only trace of V1 changes. Backfill writes one `BASELINE` event per existing `UserSkill` (`previous = null`, `new = current`, `occurredAt = lastAssessedAt`). History begins at the baseline (D12).

---

## 15. Skill mastery

**Mastery and proficiency are the same concept in Lumio. No separate `mastery` concept is introduced.**

There is no user-facing reason for a second word: a learner would have to learn that "Advanced" proficiency is not "mastery", and a manager could not say which they meant. A binary "mastered" flag would duplicate `proficiency >= required` for a specific role, which is already the readiness statement. If product later wants a label for "at the top of the scale", it is a display name for `EXPERT`, not a model.

---

## 16. Course evidence

Preserve Phase 24 exactly: completion, then `CourseSkill`, then `SkillEvidence`, reconciled on every path, idempotent on the unique key.

| Situation | V2 behavior |
|---|---|
| Course completed | One COURSE_COMPLETION evidence per valid mapped skill, unverified, keyed `("Course", courseId)`. Contribution BEGINNER, or INTERMEDIATE once verified. No decay. |
| `occurredAt` | New. The enrollment's `completedAt`, not the write time (fixes G4). |
| Duplicate handling | Unique constraint P2002 no-op, unchanged. |
| Mapping added after completions exist | Reconciliation creates the missing evidence for COMPLETED same-tenant learners, only for the new skill, with `occurredAt = completedAt`. Unchanged from `courseSkillManagement.ts:131-142`. |
| Mapping removed | Existing evidence and projection untouched: historical fact (Phase 22). No new evidence is created afterwards. Unchanged. |
| Mapping changed | Not an operation: it is a remove plus an add, with the add reconciling. |
| Existing evidence REJECTED or VERIFIED at remap time | Left as is; never resurrected or duplicated (`reconciliation.test.ts:285,316`). |
| Cross-tenant mapping | Skipped at write, as today, and additionally excluded by `valid()`. |

---

## 17. Quiz evidence

| Question | V2 |
|---|---|
| Passed | Creates or confirms one QUIZ_SCORE row per learner, quiz and skill. Grant BEGINNER, INTERMEDIATE when verified. |
| Failed | No evidence and no capability effect. The attempt and QUIZ_COMPLETED event remain. Preserved. |
| Repeated attempts | Later passes are no-ops on the unique key. Preserved (Phase 25). |
| Best vs latest score | **Neither.** The row records the first pass and does not change. Best and latest are available from `QuizAttempt`, the authoritative source, when analytics need them. Score does not affect the level, so first-pass immutability costs nothing. |
| Final exhausted attempt | No evidence. Being locked out is an outcome recorded in attempts. |
| `maxAttempts` | Governs attempts only. Not part of evidence identity. |
| Source identity | `("Quiz", quizId)`. Historical `("QuizAttempt", attemptId)` rows are legal and remain; confidence counts evidence types, so they do not inflate corroboration. |
| Score relation | `score` is the quiz percentage; `scorePercent` = `score`. |

---

## 18. Assignment evidence

Two unrelated things are both called an assignment in this codebase. V2 keeps them separate.

**1. `Assignment` / `AssignmentSubmission`** (a graded lesson task). Grading creates ASSESSMENT evidence, keyed by the submission. This is evidence because a qualified person graded work. Unchanged, except that `scorePercent = score / maxScore` is snapshotted at grading (G5). Any graded score, including 0, still qualifies, as today (`outcomes.test.ts:647`); adding a pass mark requires a schema field the assignment does not have and is deferred (D13).

**2. `LearningAssignment`** (Phase 28: an admin assigns a course to a learner). **Assignment state is not evidence, and V2 states that as an invariant.**

| Assignment state | Capability effect |
|---|---|
| Assigned | None. Being assigned proves nothing. |
| Started | None. |
| Completed | Only indirectly: assignment completion is derived from `Enrollment.status = COMPLETED`, which is the trigger for ordinary COURSE_COMPLETION evidence. The boundary is that *the course completion* is the qualifying event, not the assignment. |
| Overdue | None. No negative evidence. |
| Cancelled | None. Evidence already earned is untouched; cancellation never touches capability (`assignments.ts` cancel path already states this). |

`LearningAssignment` is a **consumer** of capability: `createCapabilityGapAssignment` reads `computeCapabilityGap` and snapshots required and current proficiency into `reason` (`assignments.ts:497-524`). Two consequences: those snapshots use the current enum values, which is a reason not to change the enum; and the gap assignment must stop being creatable for `NOT_ASSESSABLE` requirements (section 19). A test in the same style as the learning-path independence tests should assert that `learning-assignment` never writes `SkillEvidence`.

---

## 19. Role readiness V2

### 19.1 One evaluator

A pure function, no I/O, used by `computeCapabilityGap`, both reports, the copilot contexts, the recommendation engine and the gap-assignment guard. It removes the triplication (G9).

```
evaluateRequirement(requirement, skillState, policy) -> RequirementResult
  requiredLevel, currentLevel
  status:
    MET             current >= required
    BELOW           0 < current < required
    MISSING         current = NONE (no valid contributing evidence)
    NOT_ASSESSABLE  required > policy.maxGrantableLevel   (no evidence path can currently demonstrate it)
  levelsShort       ordinal distance, >= 0
  confidence        the projection's evidenceConfidence (a qualifier)
  supportingEvidence  ids of evidence that grant the current level
  lastChange        { cause, at } of the latest event for this skill, or null

evaluateRole(requirements[], states) -> RoleReadiness
  ready             boolean | null    null when the role has no requirements
  met, total
  requirements[]    every RequirementResult, always present
```

`maxGrantableLevel` is derived from the policy table, so `NOT_ASSESSABLE` disappears by itself when the assessor path (30.8) raises the reachable ceiling. It is not a flag anyone sets.

### 19.2 Answers to the brief's questions

| Question | V2 |
|---|---|
| Minimum required proficiency | Unchanged: `RoleSkill.requiredProficiency`. |
| Confidence requirements | None. Confidence qualifies a MET result; per-role minimum confidence is rejected for now. |
| Stale evidence | Expired evidence does not contribute, so its loss appears as BELOW or MISSING with `lastChange = EVIDENCE_EXPIRED`. Aged evidence still counts; only confidence changes. |
| Verified evidence | Required to reach INTERMEDIATE (as today), and to reach HIGH confidence. |
| Missing evidence | MISSING. |
| Partially satisfied | BELOW, with `levelsShort`. No fractional credit. |
| Progress toward readiness | Counts (`met` of `total`) plus per-skill levels. **No aggregate percentage as the sole explanation**, and none is defined. |
| Regression from readiness | Derived from events (section 14): when a requirement went from MET to not MET, and the cause. |
| Unreachable requirement | `NOT_ASSESSABLE`. Counts as not met (a role cannot be claimed ready against a requirement no one can currently evidence) but is reported separately, and is **excluded from recommendations and gap assignments**, which cannot close it. |

### 19.3 The explanation contract

> "You are not ready for **Backend Engineer** because 2 of 5 required skills are below the required level: **SQL** (Beginner, needs Intermediate: verified evidence needed), **System design** (No evidence, needs Beginner). **Distributed systems** requires Advanced, which no evidence path can currently demonstrate; ask your administrator."

Every clause maps to one field of a `RequirementResult`. The explanation is generated from structured results, not from a model.

---

## 20. Backward compatibility

The rule is: existing records get a **compatible V2 interpretation** first; new behavior applies second.

| V1 item | After V2 |
|---|---|
| `UserSkill` rows | Kept. `proficiency` and `lastAssessedAt` unchanged in meaning. New derived columns are null until first recompute. Deprecated, untouched: `confidence` (Int), `targetProficiency`, `status`. |
| `SkillEvidence` rows | Kept. Interpreted as `state = ACTIVE`, `validUntil = null`, `revision = 0`. `occurredAt` backfilled (see below). |
| Existing proficiency values | Recomputed under policy 1 and required to equal the stored value (section 21.4). Differences are reported, not silently overwritten. |
| Evidence source types | Unchanged. The three writers, and their `(sourceType, sourceId)` keys, are untouched. |
| Verification fields | Kept. `REJECTED` is interpreted as excluded. `verifiedById` on an existing REJECTED row stays (harmless); new transitions clear it and record the actor in the event. |
| Course completion evidence | Unchanged, plus `occurredAt`. |
| Quiz evidence | Unchanged. Legacy `"QuizAttempt"` rows remain and are grouped by evidence type for confidence. |
| Role gaps | `met` is byte-identical for every requirement at or below the reachable ceiling. Requirements above it gain status `NOT_ASSESSABLE` but keep `met: false`. |
| Recommendations | Identical, except requirements that no evidence path can close are no longer recommended (behavior change, D7). |
| Capability profile | Additive: confidence, state, expiry, history. No field removed. |
| API consumers | Response extensions only (section 26). One request enum is extended; no existing value changes meaning. |
| `LearningAssignment.reason` snapshots | Untouched; the enum values they store are unchanged. |
| Dead fields | Not dropped in Phase 30. A later cleanup phase may drop them once nothing references them. |

`occurredAt` backfill: `COURSE_COMPLETION` from `Enrollment.completedAt`, `QUIZ_SCORE` from `QuizAttempt.completedAt` of the earliest passing attempt (or `createdAt` when it cannot be resolved), `ASSESSMENT` from `AssignmentSubmission.gradedAt`; anything else falls back to `createdAt`. `scorePercent`: quiz = `score`; assessment = `score / Assignment.maxScore` where the assignment still resolves, else null. Null means "unknown", never zero.

**Unavoidable migration:** none destructive. The only data step is the backfill above and the baseline events.

---

## 21. Migration strategy

### 21.1 Sequence

| Step | Type | Content | Reversible |
|---|---|---|---|
| S0 | Pre-flight (read-only) | Audit queries (below) | n/a |
| S1 | **Schema** | Additive only: three enums, the new columns, the `SkillProficiencyEvent` table and indexes. All nullable or defaulted. | Yes: drop the additions; no V1 data changed |
| S2 | **Data** | Idempotent, batched per tenant: `occurredAt`, `scorePercent`, one `BASELINE` event per `UserSkill`, `eventSeq = 1`, `policyVersion = 1` | Yes: null the new columns, delete events |
| S3 | **Runtime (shadow)** | Add the pure policy and evaluator; run them *beside* the V1 writers and compare; nothing they compute is served | Yes: remove the shadow call |
| S4 | **Reconciliation** | Prove equivalence (section 21.4) | n/a |
| S5 | **Runtime (cutover, policy 1)** | Switch writers to the single locked recompute, and the readers to the shared evaluator, with policy 1 (V1-equivalent) | Yes: constant back to V1 path |
| S6 | **Semantic activation** | Policy 2 features, one at a time, each its own slice | Yes: constant back to 1, then recompute |

Zero-downtime: yes throughout. Additive: S1 to S5. Feature-flagged: one server-side constant `CAPABILITY_POLICY_VERSION` (plus an on/off for shadow mode), deliberately not a per-tenant table.

### 21.2 Pre-flight audit queries (S0)

1. Evidence rows whose type is not one of the three written types, and rows with `PENDING` (expected 0; makes policy 1 equal policy 2 on real data).
2. Tenant consistency: `SkillEvidence`/`UserSkill` where `tenantId` differs from the user's or skill's tenant; `RoleSkill` and `CourseSkill` whose skill tenant differs from the role's or course's tenant.
3. `UserSkill.proficiency` differing from a V1 recompute over its evidence (drift, including any victims of G2).
4. `RoleSkill` rows with `requiredProficiency` of ADVANCED or EXPERT, counted per tenant (sizes G1).
5. Evidence whose source no longer resolves.
6. Legacy `"QuizAttempt"` rows per learner and quiz.
7. Users with more than one primary role.
8. Existing `CAPABILITY_GAP` assignments whose snapshot required level is above INTERMEDIATE.

Each result is recorded in the phase audit. Query 2 decides D8 (composite tenant constraints).

### 21.3 Concurrency in the recompute (fixes G2)

One function `recomputeUserSkill(tx, key)` is the only projection writer. Inside the caller's transaction it (1) inserts the `UserSkill` row if absent (`ON CONFLICT DO NOTHING`), (2) takes `SELECT ... FOR UPDATE` on it, (3) reads the evidence set under the lock, (4) computes, (5) writes the projection and `eventSeq`, and (6) appends the event. Every path that changes evidence calls it. Serializing on the projection row means the second writer sees the first writer's committed evidence, which closes the lost-update case. This is the same lock pattern the repository already uses for enrollments (`attempt/route.ts`, `assignments.ts` cancel path).

### 21.4 Reconciliation proof

Before S5, a read-only check must show, over every `(tenant, user, skill)`:

- stored `UserSkill.proficiency` equals the policy-1 recompute (any difference is either a G2 victim or a defect, listed individually);
- the shared evaluator equals the three V1 comparisons over every `(learner, role)` pair, at every level;
- every V1 API response is unchanged apart from added fields (golden responses for the capability routes).

S5 is not enabled until the difference set is empty or explained.

---

## 22. Tenant and security model

| Record | Tenant ownership | User ownership | Authorization boundary | Cross-tenant | Deleted user | Deleted skill |
|---|---|---|---|---|---|---|
| `SkillEvidence` | `tenantId` on the row | `userId` | Learner reads own; instructor via shared enrollment and owned source course; ORG_ADMIN tenant-wide via reports | Never readable or mutable: every query filters `tenantId`; `valid()` excludes inconsistent rows | Retained; excluded from reports; verification refused | Cascades (no app path deletes skills; archive is the norm) |
| `UserSkill` | `tenantId` | `userId` | Same as evidence | Same | Retained; excluded from reports | Cascades |
| `SkillProficiencyEvent` | `tenantId` | `userId` | Learner reads own; instructor sees events only for evidence they can already review; ORG_ADMIN tenant-wide | Same | Retained until the user row is hard-deleted (cascade), which is the erasure path | Cascades |
| `RoleSkill` | Inherited via `role` | n/a | ORG_ADMIN | Skill tenant checked at write (`roleManagement.ts:234-240`) | n/a | Cascades |
| `CourseSkill` | Inherited via `course` | n/a | INSTRUCTOR (owner), ORG_ADMIN | Filtered at read (`outcomes.ts:76-98`) | n/a | Cascades |

Are existing composite constraints sufficient? **No, for two reasons.**

1. Nothing in the database ties an evidence or projection row's `tenantId` to the learner's and skill's tenant. Every check is application code. Proposed: composite foreign keys `(userId, tenantId)` to `User(id, tenantId)` and `(skillId, tenantId)` to `Skill(id, tenantId)` on `SkillEvidence`, `UserSkill` and the new event table, which requires a unique index on `User(id, tenantId)` and `Skill(id, tenantId)`. `User.tenantId` is nullable and a FREE user then simply cannot have capability rows, which matches the existing "no tenant, no capability" rule. This is an invasive change to two existing tables and depends on the S0 audit finding no violating rows (D8). The `user.update` call sites reviewed (the Clerk `user.updated` handler updates only name, email, avatar and role) show no path that changes `User.tenantId` after creation, so the constraint is not expected to obstruct a flow. That was checked by reading, not exhaustively, and the 30.0 audit should confirm it before the constraint is added.
2. `UserSkill` is unique on `[userId, skillId]` without `tenantId`. That is safe only because a user belongs to one tenant. The composite FK makes it structural.

For `RoleSkill` and `CourseSkill`, adding tenant columns would need a data migration and would duplicate the parent's tenant. Recommendation: keep the runtime filter, but centralise it in one function and add the S0 audit as a repeatable check (D8).

**Authorization additions.** Lowering actions (reject, un-verify, revoke) may be taken by ORG_ADMIN in their own tenant (D3), and must not require a resolvable source. Raising actions keep V1's independence rule. Every new endpoint requires `requireTenant` and returns not-found rather than forbidden for another tenant's records, following Phase 19 and Phase 22. History reads by an instructor use the same "evidence you own the source of" rule as V1 (`verification.ts:283-287`), so another instructor's course never leaks through history.

---

## 23. Audit and event model

### 23.1 What must be explainable, and where it is recorded

| Question | Recorded in |
|---|---|
| Current proficiency | `UserSkill.proficiency` |
| Why at this level | `SkillProficiencyEvent.contributing` and the policy table |
| Which evidence contributed | `contributing`, `evidenceId` |
| When it changed | `recordedAt`, `occurredAt`, `seq` |
| What caused it | `cause` |
| Who verified or revoked evidence | `actorId`, `actorRole`, `reason` |

### 23.2 Reuse or new: why not `LearningEvent`

The brief asks to reuse existing event infrastructure where appropriate. For the audit trail, `LearningEvent` is the wrong substrate, and the reasons are structural:

- It is deliberately **outside** the capability transaction, and its own contract (`emit.ts:14-23`) requires callers to swallow failures. A trail that answers "why is my level INTERMEDIATE" cannot be best-effort.
- It has no uniqueness guarantee; `outcomes.test.ts:196` documents duplicate events under concurrent duplicates as a known, accepted gap.
- It has no field for previous and new state, actor or reason.

Two options: a new append-only table written inside the projection transaction (recommended), or making `LearningEvent` transactional, which would **reverse a locked Phase 5 decision** and change the failure semantics of every existing emitter. The recommendation is to reuse the *pattern* (append-only, typed, tenant-scoped, indexed by tenant and time) and not the failure semantics.

`LearningEvent` remains the behavioural analytics stream, unchanged. `SKILL_ASSESSED` and `SKILL_EVIDENCE_CREATED` stay reserved and un-emitted (D11): emitting them would create a second, weaker source for the same facts. Phase 31 consumers read the durable table. `AdminAuditLog` remains for platform actions (its actions and target types are typed to tenants and users).

### 23.3 Which events are durable

All of them: one row per evidence transition that reaches the projection, written in the same transaction. Failure semantics: if the event cannot be written, the evidence transition rolls back. That is correct for audit, and it does not endanger the learner's own action because the existing outer boundaries already isolate it (quiz outcome is best-effort, completion evidence is guarded, reconciliation is retried).

---

## 24. Analytics implications (Phase 31 data contract)

Nothing in Phase 30 builds analytics UI. The model must make these queries answerable from durable data, without recomputing from raw evidence.

| Audience | Question | Supplied by |
|---|---|---|
| Learner | Skill growth and regression | Events per skill, ordinal delta |
| Learner | Evidence history | `SkillEvidence` with `state`, `verificationStatus`, `occurredAt` |
| Learner | Role readiness progress | Evaluator counts now; events for when each requirement was met (section 14.4) |
| Instructor | Cohort improvement | Events joined to enrollments in the instructor's courses |
| Instructor | Evidence quality | Verified share, age distribution, `scorePercent` |
| Instructor | Assessment effectiveness | `scorePercent` against later level changes for the same skill |
| Organization | Capability distribution | `UserSkill` grouped by skill, level, `evidenceConfidence` |
| Organization | Skill gaps | Evaluator output |
| Organization | Role readiness | Evaluator over role assignments |
| Organization | Stale capability | Evidence age over the freshness window; `EXPIRED` events |
| Organization | Trends | Events by `recordedAt` window |

`scorePercent`, `occurredAt`, `evidenceConfidence` and the event indexes are the data this phase must add so Phase 31 does not need a schema change. Aggregations must read the projection and the events, never re-derive from evidence.

---

## 25. AI boundaries

The existing boundary holds and is extended, not relaxed. Today the copilot contexts reach only `computeCapabilityGap`, `getUserSkillState` and `getRecommendedLearning` and never query `SkillEvidence` (`copilotContext.ts`), and the AI grading route only *suggests* (`suggest-grade/route.ts`).

**AI may consume:** current proficiency, requirement results including status and confidence, recency signals (age, expiry), role gaps, history events (own, own-scope), learning activity. It may explain, summarise and recommend.

**AI must not, without a deterministic domain rule:**

| Prohibited | Enforcement |
|---|---|
| Directly assign or change proficiency, confidence or readiness | No AI code path calls the recompute, evidence writers or verification actions |
| Silently override, un-verify or reject verified evidence | Those actions require a human actor with the authority in section 12; the actor is recorded |
| Invent evidence, or create evidence that contributes | `AI_EVALUATION` grants NONE; a human may convert it into their own MANAGER_ASSESSMENT, which references it |
| Bypass tenant or role authorization | AI routes call the same authorised domain functions as the pages |
| Alter role requirements or course-skill mappings | Not exposed to the AI layer |
| Present an unreachable requirement as achievable | The context includes `status`; `NOT_ASSESSABLE` is passed and the prompt must not advise steps toward it |

AI recommends; the capability domain remains authoritative.

---

## 26. API compatibility

Classification: **U** unchanged, **E** response extension (additive fields), **B** behavior change, **D** deprecated, **N** new. There are **no breaking changes** to any existing request or response shape; the behavior changes are listed explicitly.

| Route | Class | Change |
|---|---|---|
| `POST /api/capability/evidence/[id]/verify` | **E, B** | Request enum extended with `unverify`, `reopen`, `revoke`, `reinstate` (existing `verify`, `reject` keep their meaning). Response keeps `{ userSkill }` and adds fields. **B:** re-verifying an already VERIFIED row is an idempotent no-op that keeps the first verifier (was: overwrite); reject clears `verifiedById`. ORG_ADMIN may now reject, un-verify and revoke (D3). |
| `GET /api/capability/recommendations` | **B** | Requirements that no evidence path can close (`NOT_ASSESSABLE`) are no longer recommended. Response shape unchanged. |
| `GET /api/org/capability` | **E** | Rows gain `status`, `confidence`. `met` unchanged. |
| `GET /api/instructor/capability`, `/[learnerId]` | **E** | Same. |
| `/api/courses/[id]/skills` GET, POST; `/[skillId]` DELETE | **U** | Behavior preserved (reconcile on add, keep evidence on remove). |
| `/api/org/roles/...` (all) | **U, E** | Validation unchanged. Requirement responses may gain `assessable`. |
| `/api/skills` GET, POST | **U** | |
| `/capability`, `/dashboard`, `/org/capability`, `/instructor/capability` (server-composed) | **E** | Confidence, expiry and explanation surfaces. |
| `/api/ai/copilot`, `/api/ai/org/copilot`, `/api/ai/instructor/copilot` | **E, B** | Context gains `status`/`assessable`; prompt text must not advise unreachable steps. |
| `GET /api/capability/history` (own) | **N** | 30.4 |
| `GET /api/instructor/capability/[learnerId]/history` | **N** | 30.4, owned-evidence scope |
| Assessed-level write (`POST /api/capability/assessments`) | **N** | 30.8, gated |
| `/api/cron/expire-evidence` | **N** | 30.3; bearer `CRON_SECRET`, like the existing crons |

Every existing client tolerates added JSON fields. The two behavior changes that could be observed by an existing consumer are the verify idempotency (D10) and the disappearance of unreachable-requirement recommendations (D7); both need explicit approval.

---

## 27. Testing strategy

Follow the repository's conventions: `pnpm test <path>` against the local Postgres test database, fixtures under `__test__/`, no new packages. **No property-testing library is installed** (`fast-check` is not in `package.json`), so property and invariant tests are written as exhaustive enumeration over the small finite domain (5 levels x 4 verification statuses x 4 states x 9 types) and randomized permutations with a fixed seed. Adding a library would be a decision for the user, not made here.

### 27.1 Unit (pure functions, no database)

Proficiency calculation, per-type grants, maximum over grants; recency and validity (`valid`, `validUntil` boundary, `asOf`); confidence rules (each branch, each boundary at 365 days); progression; regression (each cause); verification state machine (every legal and illegal transition, per actor); invalidation states; readiness evaluator (every status, `NOT_ASSESSABLE` derivation from the policy table, `ready: null` for no requirements).

### 27.2 Invariants (exhaustive or seeded-random)

| ID | Invariant |
|---|---|
| INV1 | Projection is a pure function of (evidence, policy, asOf): the same input in any order gives the same output |
| INV2 | Invalid evidence (REJECTED, non-ACTIVE, expired, tenant-inconsistent) never contributes |
| INV3 | Foreign-tenant evidence never contributes |
| INV4 | Revoked evidence never contributes |
| INV5 | Proficiency is within NONE..EXPERT and never exceeds the policy's `maxGrantableLevel` |
| INV6 | `MET` is never reported when `current < required`; `NOT_ASSESSABLE` is never reported when `required <= maxGrantableLevel` |
| INV7 | Re-processing the same evidence or transition is idempotent: no new row, no new event |
| INV8 | Events chain: each `previous` equals the prior `new` for the same (user, skill), and `seq` is gap-free |
| INV9 | Every transition that reaches the projection has exactly one event |
| INV10 | Lowering actions never raise the level; raising actions are never taken by the subject |
| INV11 | Removing any single evidence row never raises the level |
| INV12 | AI-typed evidence never changes the level |

### 27.3 Concurrency (against the real database)

Simultaneous evidence writes for one learner and skill from different sources; simultaneous verify and reject on **different** rows of the same skill (the G2 case, which today has no test); simultaneous verify and revoke on the **same** row; simultaneous recalculation and expiry; a stale `revision` is rejected and retried. Each must end with projection equal to a fresh recompute and an event chain that satisfies INV8.

### 27.4 Migration

The reconciliation proof (section 21.4) executed as tests over a fixture that includes: legacy `"QuizAttempt"` rows, REJECTED and VERIFIED rows, an archived skill, a user with two primary roles, a cross-tenant mapping, and an ADVANCED requirement. Backfill idempotency (run twice, identical result).

### 27.5 Failure isolation (Phases 25-27 patterns)

Event-write failure rolls back its own transition only; a failing expiry for one learner does not block others and re-running recovers; a failing history read never breaks the profile page; the quiz and completion outer boundaries are unchanged and still never throw or still rethrow after side effects, as they do today. Existing capability tests (`proficiency`, `verification`, `reconciliation`, `outcomes`, `gaps`, `recommendations`, both reports, both copilot contexts) must stay green unmodified through S5, which is the practical definition of "V1 preserved".

---

## 28. Overengineering review

| Idea | Decision | Reason |
|---|---|---|
| Numeric 0-100 canonical proficiency | **Rejected for now** | Breaks every ordinal consumer and the persisted assignment snapshots; false precision from coarse evidence |
| ML or opaque AI proficiency scoring | **Rejected for now** | Conflicts with the existing "AI recommends, domain decides" boundary; unexplainable; nothing in the requirements needs it |
| Weighted-sum evidence engine | **Rejected for now** | No common score scale (G5); needs parameters no data supports; ruins one-sentence explanations |
| Hard time decay of activity evidence | **Later phase, after data** | Correct parameters are unknowable until history exists; explicit expiry covers certifications |
| Tenant-configurable policy, weights, windows | **Rejected for now** | No tenant has asked; makes every invariant tenant-parameterised |
| Per-role minimum confidence | **Rejected for now** | Adds requirement configuration for a qualifier |
| Canonical event sourcing | **Rejected for now** | The projection is already order-independent and correct; replay is a rewrite without a requirement |
| Snapshot table in addition to events | **Rejected for now** | Events answer all seven history questions; snapshots are an optimisation with no query to justify them |
| Readiness history table | **Rejected for now** | Derivable from events under current requirements; the limitation is documented |
| Reusing `LearningEvent` as the audit substrate | **Rejected** | Best-effort by contract (section 23.2) |
| Generic verification workflow, queues, notifications | **Phase 35** | Explicitly out of scope; a single flag transition suffices |
| Learner "request verification" (PENDING) | **Later** | Useful, but needs a queue to be worth anything (D9) |
| Multi-dimensional skill graph, prerequisites between skills | **Later phase** | Premature; no requirement |
| Separate mastery concept | **Rejected** | No user-facing reason |
| Composite tenant FKs on `User`/`Skill` | **Phase 30 (30.1), subject to audit** | Cheap structural guarantee; but invasive, hence D8 |
| Tenant columns on `RoleSkill`/`CourseSkill` | **Rejected for now** | Data migration for a check that already exists in code |
| Single locked recompute, event table, `revision`, `occurredAt`, `scorePercent`, `validUntil`, shared evaluator | **Phase 30** | Each answers a named V1 gap (G2-G5, G9) |
| Assessor evidence path | **Phase 30 slice 30.8, gated** | Only way to make the top two levels real; new write path, so it needs approval |
| Dropping dead columns | **Later cleanup** | Non-destructive rule for this phase |

---

## 29. Proposed implementation phases

Adjusted from the brief's order for one dependency reason: **history events must be written by the same transaction as the recalculation, so the write side of 30.4 moves into 30.2**. 30.4 becomes the history *read* side. Also added: a pre-flight (30.0) and the gated assessor slice (30.8).

| Slice | Scope | Behavior change |
|---|---|---|
| **30.0** Pre-flight audit | The S0 queries; results recorded; decides D8 | None |
| **30.1** Contract and schema foundation | Additive schema (S1); pure `policy` (policy 1) and readiness evaluator with exhaustive equivalence tests; composite tenant FKs if D8 approves | None |
| **30.2** Deterministic recalculation, events, backfill | Single locked `recomputeUserSkill`; event table written in-transaction; S2 backfill; shadow comparison (S3, S4); fixes G2 | None (V1-equivalent) |
| **30.3** Recency, confidence, verification, invalidation | Policy 2; validity states; verification state machine and authority; expiry cron; confidence | Yes, flagged: verify idempotency, new actions |
| **30.4** History reads and audit surfaces | Learner and instructor history endpoints; evidence-transition audit view | Additive |
| **30.5** Role readiness V2 | Consumers migrated to the shared evaluator; `NOT_ASSESSABLE`; recommendation and gap-assignment guard | Yes: unreachable requirements stop being recommended or assigned |
| **30.6** Profile and recommendation migration | Capability profile, dashboard, reports, AI contexts show status, confidence, expiry, explanation | Additive |
| **30.7** Analytics data foundation | Aggregate read functions and indexes for Phase 31; no UI | None |
| **30.8** Assessor path (gated) | Assessed-level evidence, authority ceilings, supersession; raises the reachable ceiling | Yes: ADVANCED and EXPERT become reachable |

Order constraints: 30.1 before everything; 30.2 before 30.3; 30.3 before 30.8; 30.5 needs the evaluator from 30.1 and the policy from 30.3 (for `maxGrantableLevel`). 30.8 may be scheduled before 30.6 if approved.

**Hotfix option (D7).** G1 is live harm today. A minimal guard (skip requirements above INTERMEDIATE in recommendations and gap assignments) could ship before 30.5 as a small standalone change. It is a behavior change to the assignments domain and to the recommendation engine, so it is a decision for the user, not an implicit part of this discovery.

---

## 30. Open decisions requiring explicit approval

| ID | Decision | Recommendation |
|---|---|---|
| D1 | Keep the five-level enum; user-facing definitions for ADVANCED and EXPERT as human-assessed levels | Approve |
| D2 | Introduce the assessor path (30.8) in Phase 30, with authority ceilings (INSTRUCTOR to ADVANCED, ORG_ADMIN to EXPERT); or defer and keep top levels unreachable | Approve, as the last slice |
| D3 | ORG_ADMIN may reject, un-verify and revoke within their tenant (lowering only). ORG_ADMIN still may not verify | Approve |
| D4 | No hard time decay of activity evidence in Phase 30; revisit after history data exists | Approve |
| D5 | Freshness window of 365 days, used only for confidence and "review due" | Approve |
| D6 | Daily expiry cron; accepted lag of up to one day for explicitly expiring evidence | Approve |
| D7 | Ship a stand-alone guard so unreachable requirements are not recommended or assigned before 30.5 | Approve as an early small change, or accept the wait |
| D8 | Composite tenant FKs `(userId, tenantId)` and `(skillId, tenantId)` on capability tables; requires unique indexes on `User` and `Skill` | Decide after the S0 audit; recommend yes if clean |
| D9 | Learner "request verification" (PENDING) | Defer |
| D10 | Re-verifying VERIFIED evidence becomes an idempotent no-op keeping the first verifier | Approve |
| D11 | `SKILL_ASSESSED` and `SKILL_EVIDENCE_CREATED` stay reserved and un-emitted | Approve |
| D12 | History starts at a `BASELINE` event; pre-V2 changes are not reconstructible | Accept |
| D13 | Score does not affect level in Phase 30; a pass mark for assignments (new `Assignment` field) is a later, separate change | Approve |
| D14 | Dead columns are deprecated and left in place; dropped in a later cleanup | Approve |
| D15 | `NOT_ASSESSABLE` counts as not met, is reported separately, and is excluded from recommendations and assignments | Approve |
| D16 | Instructor history visibility is limited to evidence they own the source of | Approve |
| D17 | Single server-side policy-version constant is the only flag; no per-tenant configuration | Approve |
| D18 | Whether a property-testing library is acceptable; otherwise exhaustive enumeration is used | Enumeration unless told otherwise |

---

## 31. Final recommended contract

The compact, numbered specification is `docs/PHASE_30_CAPABILITY_PROFICIENCY_V2_CONTRACT.md`. In brief:

1. Levels stay NONE, BEGINNER, INTERMEDIATE, ADVANCED, EXPERT.
2. `SkillEvidence` is the truth; `UserSkill` is a cache that equals a pure function of the valid evidence set and policy version.
3. Level is the maximum grant over valid evidence; grants come from a versioned table; policy 1 equals V1.
4. Valid means ACTIVE, not REJECTED, not expired, tenant-consistent. Existing, valid and contributing are different questions.
5. No hard decay in Phase 30; explicit `validUntil` expires; a 365-day freshness window affects confidence only.
6. Confidence is derived, categorical (LOW, MEDIUM, HIGH), never an input, and qualifies without gating.
7. Regression happens only by recalculation. Raising needs an independent accountable source; lowering is wider and never needs the source to resolve.
8. Every transition that reaches the projection writes one `SkillProficiencyEvent` in the same transaction. No snapshots, no event sourcing, no reuse of `LearningEvent`.
9. Evidence is never deleted.
10. Readiness is one pure evaluator with statuses MET, BELOW, MISSING, NOT_ASSESSABLE, always with per-skill detail, never an aggregate score alone.
11. Assignment state is not evidence; only qualifying learning and assessment outcomes are.
12. AI consumes capability data and never writes it.
13. V1 equivalence is proven by reconciliation before any semantic change, behind one policy-version constant.

---

## Appendix A. Files inspected

Schema and docs: `prisma/schema.prisma` (enums, capability models, `LearningEvent`, `LearningAssignment`, `Quiz`, `QuizAttempt`, `Assignment`, `AssignmentSubmission`, `Enrollment`, `User`, `Tenant`, `Team`, `TeamMember`, `AdminAuditLog`); migrations `20260909180000_add_v2_capability_knowledge_ai_foundation`, `20260911000000_add_skill_evidence_uniqueness`; `docs/V2_DOMAIN_MODEL.md`, `docs/V2_ROADMAP.md` (Phase 5, 6, 7 sections), `docs/V2_MIGRATION_MAP.md`, `docs/SCHEMA.md`, `docs/API.md`, `docs/STACK.md`, `docs/DESIGN_SYSTEM.md` (searched; no capability content in the last four).

Capability domain (`src/lib/domain/capability/`): `proficiency.ts`, `proficiencyOrder.ts`, `evidence.ts`, `outcomes.ts`, `verification.ts`, `reconciliation.ts`, `gaps.ts`, `recommendations.ts`, `courseSkillManagement.ts`, `roleManagement.ts`, `organizationReport.ts`, `instructorReport.ts`, `copilotContext.ts`, `skillListing.ts`, `types.ts`. Test titles read for `proficiency`, `verification`, `evidence`, `reconciliation`, `outcomes`, `gaps`.

Callers and consumers: `src/app/api/courses/[courseId]/lessons/[lessonId]/complete/route.ts`, `src/app/api/quizzes/[quizId]/attempt/route.ts`, `src/app/api/assignments/[assignmentId]/submissions/[submissionId]/grade/route.ts`, every capability, role, skill, course-skill route file, `src/lib/domain/learning-events/emit.ts`, `src/lib/admin-audit.ts`, `src/lib/domain/learning-assignment/assignments.ts` (gap assignment), `adminAssignments.ts`, `learnerAssignments.ts`, the learning-path independence and read-only tests, `src/lib/ai/prompts.ts` (capability sections), the AI grade-suggestion route header, `src/app/api/webhooks/clerk/route.ts` (tenant mutation check), `vercel.json` (crons), and the student capability page and client.

## Appendix B. What was and was not verified

Not run: the test suite (test titles and code were read instead; a full run adds no information for a discovery pass, and one known cron test flakes). Not reproduced: G2 (the projection lost-update race) is derived from the transaction structure and READ COMMITTED semantics and is marked as such. The proposal for it is a lock, which is correct whether or not the race is observable in practice. The S0 audit will measure any actual drift on real data.
