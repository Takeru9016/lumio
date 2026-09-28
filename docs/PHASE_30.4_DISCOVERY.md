# Phase 30.4 — Capability History Read Surface: Contract Discovery

Status: discovery only. No Prisma schema, migration, production code, API or UI change accompanies this document.
Builds on `docs/PHASE_30.1_IMPLEMENTATION.md`, `docs/PHASE_30.2_IMPLEMENTATION.md`, `docs/PHASE_30.3_DISCOVERY.md` (`PHASE_30.3 IMPLEMENTATION APPROVED`) and `docs/PHASE_30.3_IMPLEMENTATION.md` (`PHASE_30.3 COMPLETE`). Read against repository HEAD `f9b39b9`; Phase 30.3's implementation exists as uncommitted working-tree changes on top of that commit (per Phase 30.3's own closing instruction not to commit) — this document reads the actual `verification.ts`/`capabilityBackfill.ts`/`prisma/schema.prisma` files and migration SQL on disk, not the commit history, so it reflects what 30.3 actually shipped, not what HEAD alone shows.

**Production condition, restated so it cannot be missed:** D24 production remediation has **not** run against Neon (`docs/PHASE_30.3_IMPLEMENTATION.md` §25, literal line `Production D24 remediation: NOT RUN`). Local `lumio_test` remediation is not evidence production `occurredAt` is clean, and — a gap already flagged in 30.3 discovery §1 but, per this session's own check, never actually closed by the remediation that shipped — even the local remediation does not retroactively fix every already-written `occurredAt` value in `lumio_test` itself. See §26.

How to read this document: every claim about current behavior is **[code]** (read directly, cited by file:line, this session), **[test]** (locked by a named test), or **[derived]** (follows from the code's structure, not reproduced live). Research combined direct reading of `prisma/schema.prisma`, the migration SQL files, `verification.ts`, `capabilityBackfill.ts`, `evidence.ts`, `instructorReport.ts`, `adminAssignments.ts`, `auth/context.ts`, the Clerk webhook route, the learner/instructor/org capability pages, and a live `psql` query against `lumio_test`, plus a dedicated background inventory pass (cited as **[inventory]** where it is the sole source) that grepped every production read/write of the four core models across `src/app` and `src/lib`. A prior pass of this document made several claims that direct verification overturned — an ordering claim about `recordedAt` that had the timing backwards and an unproven "stable by construction" overclaim (corrected in §12 against a live query, not just re-reasoned), a soft-delete visibility claim that was backwards for ORG_ADMIN, an internal self-contradiction about SUPER_ADMIN access, a pagination design that would have produced short/empty pages under authorization filtering, and a misattribution of an already-known risk as a new finding of this document. Each is corrected below with the evidence that overturned it, not silently fixed, matching this session's own established practice of disclosing self-corrections rather than smoothing over them (`docs/PHASE_30.3_IMPLEMENTATION.md` §16).

---

## 1. Current history implementation

**There is none. This is confirmed, not assumed.**

- **`SkillProficiencyEvent` is write-only in production.** Two writers: `projectUserSkill` (`src/lib/domain/capability/proficiency.ts:190`, the one canonical write path, called from every evidence-affecting transaction) and the Phase 30.2 `BASELINE` backfill (`capabilityBackfill.ts:331`). **[inventory, cross-checked this session]** `grep -rn "skillProficiencyEvent\." src/app src/lib --include="*.ts"` outside `*.test.ts` returns only these `.create` call sites — zero `findMany`/`findFirst`/`count` reads anywhere in production code.
- **`EvidenceStandingEvent` is write-only in production**, same pattern: the one writer is `applyEvidenceTransition` (`verification.ts:303`). Zero production reads. **[inventory, cross-checked]**
- **`SkillEvidence` is read in several places**, always tenant+user(s) scoped, never paginated beyond "one user's evidence" or "one page of users' evidence" (bounded by an outer report's own cursor — see §13): `getSkillEvidenceForUser` (`evidence.ts:26`, learner's own, feeds the `/capability` page), `getReviewableEvidenceForInstructor` (`verification.ts:423`, one student's rows, filtered **after** fetch in a per-row loop — a real anti-pattern flagged and designed around in §20), `projectUserSkill`'s own read of one (user, skill)'s evidence set under lock (`proficiency.ts:129`), plus internal recompute/backfill/reconciliation readers (`reconciliation.ts`, `policyReconciliation.ts`, `capabilityBackfill.ts`) that are never exposed as a client-facing query.
- **`UserSkill` is read broadly** (`instructorReport.ts`, `organizationReport.ts`, `gaps.ts`), always the **current** row only — `proficiency`, `evidenceConfidence`, `eventSeq`, `policyVersion` as of the last recompute. No route reads `UserSkill` history; there is no history to read, since it is a cache, not a log (contract A2).
- **No existing capability UI shows event data.** The learner page (`src/app/(student)/capability/page.tsx` → `CapabilityClient.tsx`) shows current evidence rows (`type`, `score`, `verificationStatus`, `createdAt`) per skill — the *current* `SkillEvidence` set, not any transition history. The instructor page (`InstructorCapabilityClient.tsx` + `EvidenceReviewList.tsx`) shows current `verificationStatus` badges and verify/reject buttons, no transition trail. The org page (`OrgCapabilityClient.tsx`) is the same shape, tenant-wide. **None of the three displays who verified/revoked/reinstated evidence, when, or why — that information exists only in `EvidenceStandingEvent`, unread by any UI today.** **[inventory, cross-checked against the three page/client files directly]**
- **No other repository infrastructure provides a reusable "read this event table" pattern.** `AdminAuditLog` (`schema.prisma:967-981`) is also write-only (`src/lib/admin-audit.ts`'s `logAdminAction`, never read back by any route). `AIUsageEvent` and `LearningEvent` are append-only ledgers with no read API either. **30.4 is not extending an existing history surface — it is building the first one this repository has ever exposed for any append-only event table.** This raises the bar for getting the pagination/authorization/response-shape decisions right the first time (§13-§18), since there is no existing precedent to inherit bugs from, but also none to lean on for "this is already proven safe."

---

## 2. Product purpose

Restating the task's own framing against what actually exists today, so "history" is scoped to real, answerable questions rather than a raw table dump (§18's discriminator, §4-§5's field lists all trace back to this list):

**Learner**, answerable directly from the two event tables plus the current `UserSkill`/`Skill` rows:
- *How has my proficiency changed?* → `SkillProficiencyEvent` sequence for (their own tenant, their own user, a skill), ordered by `seq`.
- *When and why?* → `occurredAt`/`recordedAt` + `cause` + `previousProficiency`/`newProficiency` on the same rows.
- *Which evidence contributed?* → `contributing` (json snapshot) on the event, or the live `evidenceId`/`evidenceRevision` pointer for transition-triggered events.
- *What happened to my evidence (verified/rejected/revoked)?* → `EvidenceStandingEvent`, filtered to evidence they are the subject of.
- *What is my current state?* → already served by the existing `/capability` page (§1) — 30.4 does not re-answer this, it explains how the current state was reached.

**Instructor**, scoped to evidence they are authorized to act on (§7, D16 — already a locked, existing pattern, not invented here):
- *How has a learner's skill changed, and which evidence supports it?* → the same two tables, filtered to evidence whose source resolves to a course the instructor owns.
- *What happened to evidence I reviewed?* → `EvidenceStandingEvent` rows where the instructor was the actor, or where the evidence is in their reviewable set.

**ORG_ADMIN**, tenant-wide (§8):
- *How has capability changed for a learner in my tenant?* and *what verification/revocation actions occurred, by whom?* — both tables, tenant-scoped, no course-ownership narrowing (ORG_ADMIN already has broader read authority than INSTRUCTOR in every existing capability report — `organizationReport.ts` has no per-course filter INSTRUCTOR's report has).

**Not built merely because it exists**: raw `id`s, `tenantId` on response items (redundant — the caller already knows their own tenant), internal `policyVersion`/`revision` numbers as anything but an internal ordering aid, `actorId` for the learner-facing view (§6), or a generic "show me every field on every row" dump. Every field in §4/§5 is justified against one of the questions above, not included by default.

---

## 3. History vs audit distinction

Three tiers, kept explicitly separate — this document does not blur them, and the response contract (§17) must not either:

| Tier | Answers | Backing table(s) | Audience |
|---|---|---|---|
| **Capability history** | "How did my/a learner's proficiency evolve, and why?" | `SkillProficiencyEvent`, transformed into a domain read model (§4) | Learner (own), instructor (owned scope), ORG_ADMIN (tenant) |
| **Evidence-standing history** | "What happened to this specific piece of evidence, who did it, and why?" | `EvidenceStandingEvent`, transformed (§5) | Same three, same scoping — this is not a separate audience, just a separate *event type* within the same history surface (§18's combined-timeline decision) |
| **Security/operational audit** | "What administrative/platform action was taken, by whom, for compliance/incident purposes?" | `AdminAuditLog` (platform-only, no tenant scope — 30.3 discovery §26 already found it structurally cannot represent a tenant-scoped capability transition) | SUPER_ADMIN / platform operators only — **out of 30.4's scope entirely**, not touched, not extended |

**The first two tiers are not raw audit data re-presented to end users** — they are read models (§4/§5) with a small, deliberate transformation from the underlying Prisma rows: internal-only fields dropped (§6), actor identity redacted per role (§6/§7), and each item carries a stable domain discriminator (§17) rather than exposing the Prisma model name. This is the same posture the existing `RequirementResult`/`RoleReadiness` read models already take over raw `UserSkill`/`RoleSkill` rows (contract §G3/G4) — 30.4 follows that precedent, it does not invent a new one.

**No redaction/transformation is needed for tier 3** because 30.4 does not touch it at all — `AdminAuditLog` stays exactly as 30.3's discovery left it, unread by any route.

---

## 4. Learner contract

**Scope: own tenant + own user only, no exception.** This matches the existing, locked self-scoping convention `getSkillEvidenceForUser` already uses — **[code, `evidence.ts:17-20`]**: "tenantId and userId come only from ctx, never from a parameter... mirroring `computeCapabilityGap`/`getRecommendedLearning`'s existing self-scoping (Phase 7 locked contract)." 30.4's learner history function must take the same shape: `(ctx: AuthContext & {tenantId: string}, filters, page)` — **no `userId` parameter at all**, so there is no client-suppliable field to forge in the first place (not "validate userId matches ctx.userId," but "there is no userId parameter to validate"). This is stronger than a runtime check and is the existing convention, not a new one.

**Does the learner need proficiency history, evidence-standing history, or both?** Both, per §2's question list — a learner asking "why did my quiz-verification get revoked" needs `EvidenceStandingEvent`; a learner asking "when did I reach INTERMEDIATE" needs `SkillProficiencyEvent`. §18 decides whether these are one endpoint or two; either way, both event types must be reachable by the learner for their own data.

**Domain read model, not raw Prisma records** — two item shapes (unioned per §18):

```
LearnerProficiencyHistoryItem = {
  type: "PROFICIENCY_CHANGED"
  skillId, skillName
  cause: ProficiencyEventCause        // already a safe, closed enum — no redaction needed
  previousProficiency, newProficiency
  previousConfidence, newConfidence
  occurredAt, recordedAt
  evidenceId | null                   // present when this event was triggered by one evidence
                                       // transition; the learner already owns this evidence, so
                                       // exposing its id is not a leak (contrast §6's instructor case)
  actorRole: Role | null              // no actorName field exists on SkillProficiencyEvent at all
                                       // (schema.prisma:1228-1288 has actorId/actorRole, not
                                       // actorName) — role only, same posture as the standing-event
                                       // shape below; a display name for the same transition, when
                                       // one exists, lives on the paired EVIDENCE_STANDING_CHANGED
                                       // item (same evidenceId+evidenceRevision), not duplicated here
  reason | null                       // allowlist, not "any cause that happens to carry one" (§17):
                                       // non-null only for cause IN (EVIDENCE_REVOKED,
                                       // EVIDENCE_REINSTATED) — every other cause, BASELINE included,
                                       // is forced null even if the underlying row's own `reason`
                                       // column is non-null (BASELINE's is, see §6)
}

LearnerEvidenceStandingHistoryItem = {
  type: "EVIDENCE_STANDING_CHANGED"
  evidenceId, skillId, skillName
  evidenceType: EvidenceType
  sourceContext: { courseTitle | null }   // resolved display label, never a raw sourceId (§6)
  action: EvidenceStandingAction
  previousVerificationStatus, newVerificationStatus
  previousState, newState
  actorRole: Role | null              // role, not name/id — see §6/§7 for why
  reason | null
  occurredAt
}
```

`contributing` (the json snapshot on `SkillProficiencyEvent`) is **not** exposed verbatim to the learner — it is an internal list of `{evidenceId, type, verificationStatus, grant}` for every contributing row at that moment, which for a learner with several contributing evidence rows leaks nothing they don't already see on their own `/capability` page (all evidence there is already theirs), so it MAY be surfaced as a `contributingEvidenceIds: string[]` convenience field if a concrete UI need justifies it later — **not built in 30.4** unless a consuming UI slice asks for it (§30, avoid building unused response surface).

---

## 5. Evidence-standing contract

Per-role field visibility for `EvidenceStandingEvent` (the learner row in §4 is one instance of this; instructor/org views add fields learners must not see):

| Field | Learner (own evidence) | Instructor (owned scope) | ORG_ADMIN (tenant) |
|---|---|---|---|
| `evidenceType`, `sourceContext.courseTitle` | Yes | Yes | Yes |
| `action`, `previousState`/`newState`, `previousVerificationStatus`/`newVerificationStatus` | Yes | Yes | Yes |
| `reason` | Yes | Yes | Yes — this is the whole point of a revoke/reinstate reason existing; hiding it from the subject defeats the audit purpose §26 of the 30.3 discovery built the table for |
| `actorRole` | Yes | Yes | Yes |
| `actorName` (the point-in-time snapshot field, `schema.prisma:1325` — `EvidenceStandingEvent` only, see below) | **No** — see §6 | Yes, for actions on evidence they are authorized to review | Yes |
| `actorId` | **Never**, any role — internal id, not a display value (§6) | **Never** directly — if a client needs to deep-link to an actor, that is a separate, later concern, not built in 30.4 | Same |
| `evidenceId` | Yes (it's their own evidence) | Yes | Yes |
| raw `sourceId` (the free-form string, e.g. a `Quiz.id`) | **No** — resolve to a display label (`sourceContext.courseTitle`) or omit; a raw internal id is implementation detail, not a learner-facing fact | **No**, same reasoning | **No**, same reasoning — even ORG_ADMIN gets a resolved label, not a raw foreign id, since nothing in any existing report exposes raw source ids either (`getReviewableEvidenceForInstructor`'s own `ReviewableEvidenceRow` already resolves to `courseTitle`, never a raw `sourceId`, `verification.ts:449-451`) |

**Ordering key for a single-evidence-row history view (e.g., "everything that happened to this one piece of evidence"):** `evidenceRevision`, not `recordedAt` — see §12 for why this table's own revision counter, not its timestamp column, is the reliable order for one evidence row.

**`actorName` exists only on `EvidenceStandingEvent` (`schema.prisma:1325`) — `SkillProficiencyEvent` has `actorId`/`actorRole` (`schema.prisma:1255-1257`) but no name-snapshot field at all.** An earlier draft of this document stated the name-snapshot claim as applying to "both event tables"; it does not. §4's `PROFICIENCY_CHANGED` item shape is corrected accordingly: it carries `actorRole` only, never a name — matching what the underlying table actually has, not inventing a field that would need a schema change to populate. A display name for a proficiency-changing transition, where one exists (i.e., the transition was itself caused by an evidence-standing action), is available on the paired `EVIDENCE_STANDING_CHANGED` item for the same `(evidenceId, evidenceRevision)`, sitting next to it in the combined feed (§18) — not duplicated onto the proficiency item.

---

## 6. Privacy

Every item on the task's own list, decided explicitly, not left implicit:

| Concern | Decision |
|---|---|
| Verifier identity | Visible as `actorRole` to every authorized reader; `actorName` visible to instructor/ORG_ADMIN only, **never to the learner** (§5) — the existing product surface (`EvidenceReviewList.tsx`) never shows the reviewer's name to the student either, and history should not introduce a new identity leak the live UI doesn't already have. |
| Assessor identity | Same rule as verifier identity — no assessor path exists yet (30.8), so this is a forward-looking placeholder, not a live decision to revisit. |
| Rejection reasons | Visible to the subject and to every authorized instructor/admin reader — a rejection reason exists specifically so the subject can understand and act on it; hiding it from them would defeat its purpose. |
| Internal migration metadata | **A real leak, found and closed this revision.** `capabilityBackfill.ts:342` hardcodes `reason: "Phase 30.2 backfill — establishes history for a pre-existing projection; not a live transition"` on every `BASELINE` `SkillProficiencyEvent` row — an internal, implementation-referencing string, exactly what the task instructs never exposing. `proficiency.ts:201` writes `SkillProficiencyEvent.reason` as `reason ?? null` from whatever the caller passed; **[code, confirmed this session]** `grep -rn "reason:" src/lib/domain/capability` outside tests shows the only non-null caller-supplied values are `revokeEvidence`/`reinstateEvidence`'s required reason (`verification.ts:369,377`) — every other action (`verify`/`reject`/`unverify`/`reopen`) never passes one, so the DB row's own `reason` column is null for them already, and the leak is specific to `BASELINE`'s hardcoded string. **Rule: the response contract's `reason` field is an allowlist, not a pass-through** — non-null only when `cause ∈ {EVIDENCE_REVOKED, EVIDENCE_REINSTATED}` (§4), forcing every other cause's `reason` to `null` in the response regardless of what the underlying row holds. |
| Instructor comments | No such field exists on either event table today (`reason` is the only free-text field, and it is instructor/admin-authored about the *evidence*, not a separate "comment" concept) — nothing to decide; not built. |
| Evidence content | Not exposed beyond what §4/§5's item shapes already include (`evidenceType`, resolved `sourceContext`) — raw `score`/`metadata` on `SkillEvidence` itself are not part of the *history* read model at all (they belong to the existing current-evidence read, `getSkillEvidenceForUser`, unchanged by this phase). |
| Source metadata | Raw `sourceId` never exposed, any role (§5's table) — resolved to a display label or `null`, never a raw foreign id. |
| Other learners, reached through a shared source | **Structurally impossible by the query shape, and the specific D24-adjacent risk is named explicitly:** every history query is scoped by `(tenantId, userId, ...)` predicates on the event tables themselves, which already carry the correct learner's `userId` on every row (`EvidenceStandingEvent.userId`/`SkillProficiencyEvent.userId` are populated at write time from the acting evidence's own owner, `verification.ts:306`/`proficiency.ts`) — there is no cross-learner join anywhere in the read path. The specific historical failure mode this must not repeat is D24's own mechanism (30.3 discovery §1): `Enrollment`/`QuizAttempt` looked up by `courseId`/`quizId` **alone**, with no `userId` filter, silently attributing one learner's timestamp to another's evidence. **Rule for 30.4, stated so it cannot be forgotten:** any live source-context resolution this phase adds (§11's `resolveSourceCourse`-style lookup) must resolve through the evidence row's own `sourceId` to a **course**, never through a **learner-keyed** lookup like `Enrollment`/`QuizAttempt` filtered by `courseId`/`quizId` alone — `resolveSourceCourse` as it exists today (`verification.ts:60-`) already satisfies this (it resolves `Quiz → Course`, never `Quiz + courseId → Enrollment` for a *different* learner), so no new code this phase would introduce needs to touch the exact pattern that caused D24; this is recorded here as a locked constraint on any future implementer, not a currently-open risk. |
| Deleted users | See §10 — a soft-deleted learner's own history is excluded from both instructor and ORG_ADMIN reads, matching contract E6 ("retained and excluded from reports") and its existing, already-shipped implementation (`instructorReport.ts:137`, `organizationReport.ts:121`, both filter `deletedAt: null`) — corrected in this revision from an earlier draft that treated ORG_ADMIN visibility as an open decision this document got to make fresh; it is not open, it is already settled by contract and by the two existing reports' own code. |
| Archived courses | Visible — an archived course's `instructorId`/title are unaffected by `status = ARCHIVED` (30.3 discovery §16); no special-casing needed (§7). |
| Tenant information | `tenantId` never included in any response item (§4's field lists) — the caller already knows their own tenant from `ctx`; echoing it back is redundant surface area with no use. |

---

## 7. Instructor authorization

**Course-scoped, matching the existing, already-shipped `getReviewableEvidenceForInstructor` pattern exactly — not learner-scoped, not skill-scoped, not a new invented boundary.** **[code, `verification.ts:411-457`]**: an instructor may see a learner's evidence only when (a) the learner shares an enrollment in a course the instructor owns (the entry gate), AND (b) that specific evidence row's own source resolves to a course the instructor owns (the per-row filter — a learner enrolled in the instructor's course can still have *other*, unrelated evidence from a different instructor's course, which is correctly excluded even though the entry gate passed).

**Soft-deleted learner — corrected in this revision, not an open decision.** An earlier draft of this document claimed a soft-deleted learner is "naturally excluded" from the instructor path because there is "no active enrollment to authorize through." **That claim was checked directly this session and is false**: `Enrollment` rows are never deleted or filtered by the learner's `deletedAt` (`getReviewableEvidenceForInstructor`'s own `enrollment.findFirst` at `verification.ts:417-420` has no `deletedAt`/status predicate), so an instructor's shared-enrollment check still succeeds for a soft-deleted learner they previously shared a course with. **Contract E6 already settles this, and both existing reports already implement it**: "A soft-deleted learner's evidence MUST NOT be acted on. It is retained and excluded from reports" — `instructorReport.ts:137` and `organizationReport.ts:121` both filter `deletedAt: null` on the learner-population query. **30.4's instructor (and ORG_ADMIN, §8) history functions must apply the identical `deletedAt: null` predicate on the subject learner**, matching the existing, locked rule — not a fresh decision, a carried-forward one this document initially missed and now states correctly.

**Pagination must filter authorization BEFORE cutting the page, not after — a real defect in this document's own first draft, found and fixed this pass.** The existing `getReviewableEvidenceForInstructor` fetches a student's full evidence set, then filters per-row by resolved course ownership (§20) — acceptable there only because the unfiltered set is small (one student) and the function returns the whole filtered list, unpaginated. **A cursor-paginated history endpoint cannot use that shape**: filtering a `limit`-sized page of raw event rows down to the authorized subset *after* the page is cut can return a page of 3 items (or 0, with a non-null `nextCursor` implying more exist) instead of a full, correctly-sized page — exactly the failure mode `adminAssignments.ts`'s own header comment exists to prevent ("a status filter is applied BEFORE the page is cut... a page must never be a window of the newest rows with the filter applied afterwards," `adminAssignments.ts:158-171`). **Corrected design:** because this route is always scoped to one `learnerId` (§16, a path segment, not a free-text search), the authorized-evidence-id set for that (instructor, learner) pair is cheap to compute once per request — batch-resolve every `SkillEvidence` row's source for that learner (§20's batched pattern, not `getReviewableEvidenceForInstructor`'s per-row loop), keep only the ids whose resolved course belongs to this instructor, and pass that id set into the event queries as `evidenceId IN (...)` **in the same `WHERE` clause as the cursor and tenant predicates**, so the page is cut only from already-authorized rows. This mirrors `adminAssignments.ts`'s own "filter before cut" discipline directly, not a new invention.

**A direct, stated consequence of that design:** `SkillProficiencyEvent` rows with `evidenceId = null` (`BASELINE`, `RECALCULATED` — contract F6's own existing nullability, neither is "about one evidence row") **cannot appear in the instructor's `evidenceId IN (...)`-filtered view**, since they have no evidence id to match against. **Decision: this is correct and acceptable, not a gap to fix.** `BASELINE` is a one-time historical marker with no real transition to explain (30.3 discovery §27); `RECALCULATED` reflects a no-op-adjacent recompute, not an instructor-relevant evidence action. An instructor's history view answering "what happened to evidence I reviewed" (§2) has no use for either. ORG_ADMIN's tenant-wide view (§8) has no such filter and sees both.

**A second, distinct consequence of the same pre-filter, stated explicitly rather than left implicit:** the authorized-`evidenceId` set is built by resolving each evidence row's source back to a course (§20); a row whose source can no longer be resolved (§10's lesson-delete cascade — the source quiz/assignment was deleted, so `resolveSourceCourse` returns `null`) fails that resolution and is therefore excluded from the instructor's authorized set entirely, even though the evidence and its full history still exist and are visible to the learner and to ORG_ADMIN (with `sourceContext.courseTitle: null`, §10/§11). **This is a fail-closed outcome, matching verification's own existing posture** (`verification.ts`'s `requiresSourceResolution` path already refuses to act on an unresolvable-source row for the same reason — an instructor's authority is defined *through* course ownership, and an unresolvable source means that ownership can no longer be confirmed). An instructor therefore cannot see even an ORG_ADMIN's `REVOKE` of evidence whose source was deleted, once the source is gone — a real, product-visible gap, but the correct default (failing open would let an instructor see evidence for a course they can no longer be proven to own), and not a new gap 30.4 introduces (the same evidence is already unreachable through `getReviewableEvidenceForInstructor` today, for the identical reason).

**Explicitly not adopted:**
- **Learner-scoped** ("any capability history of a learner I'm authorized to supervise") — rejected. No manager hierarchy exists in the data model (`Team`/`TeamMember` carry no role field, confirmed again this session at `schema.prisma:417-444`, matching 30.3 discovery §24's same finding), and this would let an instructor see history for skills entirely unrelated to any course they teach that learner in.
- **Skill-scoped** ("history for skills I manage") — rejected. No concept of an instructor "owning" a `Skill` exists (`Skill` is tenant-owned, not instructor-owned); `CourseSkill` links a course to a skill, but many instructors' courses can teach the same skill, so "skill-scoped" would silently become "every instructor who ever taught any course mapping to this skill," far broader than intended.

**Historical evidence after the course is archived:** unchanged from the existing read pattern — `Course.status = ARCHIVED` does not remove the course or its `instructorId` (30.3 discovery §16: no application route deletes a `Course`). An archived course's instructor retains read access to its evidence's history, matching `gaps.ts`'s existing "archived skills stay visible in evidence, just excluded from *requirements*" posture. No special-casing needed.

---

## 8. ORG_ADMIN authorization

**Tenant-wide, no course-ownership narrowing** — matches `organizationReport.ts`'s existing posture exactly (no per-course filter exists there; ORG_ADMIN already reads every learner's current capability state tenant-wide). Extended to history: ORG_ADMIN may read `SkillProficiencyEvent`/`EvidenceStandingEvent` for any learner, any skill, within their own tenant — no additional per-row authorization check beyond the tenant predicate.

**Soft-deleted learners — excluded, matching §7's corrected rule and contract E6.** An earlier draft of this document decided, as if it were an open question this document got to resolve fresh, that "history for a soft-deleted learner remains readable by ORG_ADMIN." **That was wrong**: contract E6 already states soft-deleted learners' evidence is "retained and excluded from reports," and `organizationReport.ts:121` already implements exactly that (`deletedAt: null` on the learner-population query). 30.4's ORG_ADMIN history function must apply the same predicate. This is not a design choice 30.4 is free to make differently from the instructor scope — it is one locked rule applied identically to both.

**Historical evidence for deleted sources:** unaffected — history rows are self-contained snapshots (`skillId`, `evidenceType`, resolved `sourceContext` — see §11's live-resolve-at-read-time decision) and do not require the source to still exist to be displayed, exactly matching contract E9 ("Deleting a source record does NOT invalidate its evidence").

**All skills, all proficiency/standing history:** yes, tenant-wide, no skill-level restriction (unlike instructor — §7), subject to the `deletedAt: null` exclusion above.

---

## 9. SUPER_ADMIN behavior

**No SUPER_ADMIN-scoped capability route exists today, for anything — not verification, not the three existing reports.** **[code, re-confirmed this session]** `grep -rln "SUPER_ADMIN" src/app/api/org src/app/api/instructor src/app/api/capability` outside `*.test.ts` returns zero production matches, matching 30.3 discovery §10's identical finding ("no SUPER_ADMIN-scoped capability route exists anyway"). SUPER_ADMIN's *verification* authority is tenant-bound today (`evidence.tenantId !== actor.tenantId` throws unconditionally before any role branch, `verification.ts:206-208` — no SUPER_ADMIN exception).

**Decision: 30.4 adds no SUPER_ADMIN route or access path of any kind — not a shared path with ORG_ADMIN, not a separate one.** An earlier draft of this document suggested SUPER_ADMIN could "use the same tenant-scoped path ORG_ADMIN uses," which contradicts this same document's own §16/§29 (both of which correctly exclude SUPER_ADMIN from the `requireRole(ctx, ["ORG_ADMIN"])` gate). **Corrected: the ORG_ADMIN history route is ORG_ADMIN-only, full stop**, matching `/api/org/capability`'s own existing role gate exactly (that route does not special-case SUPER_ADMIN either). If a SUPER_ADMIN needs tenant capability history, they are outside this phase's scope entirely — no route this document specifies serves them, matching the deliberate absence of any SUPER_ADMIN-facing capability route anywhere else in the repository today. **This is a decision this document makes explicitly, not a gap left open**: broadening SUPER_ADMIN access "because the role exists" is exactly what the task's own §10 instructs against.

---

## 10. Deleted and archived records

| Scenario | Behavior |
|---|---|
| Learner soft-deleted | **Excluded** from both instructor and ORG_ADMIN history reads, matching contract E6 and its existing implementation (§7/§8 — corrected from an earlier draft that had this backwards for ORG_ADMIN). Not readable by the learner either — `deletedAt` is written by exactly one production code path, confirmed this session (`grep -rn "deletedAt:" src --include="*.ts"` outside tests and generated code returns one writer: `src/app/api/webhooks/clerk/route.ts:238`, fired on Clerk's own `user.deleted` webhook — a true account deletion, never an app-level "deactivate" toggle a route sets on its own). `getAuthContext` itself has no explicit `deletedAt` filter (`src/lib/auth/context.ts`, confirmed by direct read), and does not need one for this case — a Clerk-deleted account has no valid Clerk session left, so `auth()` (checked first, before any `User` row is even read) already returns no session. Existing rows are untouched — `deletedAt` does not cascade-delete `SkillEvidence`/event rows, so the data still exists, it is simply excluded from the *report* population, matching E6's exact wording. |
| Skill archived | Unaffected — history remains fully readable; `Skill.status = ARCHIVED` only affects *requirement* computation (`gaps.ts:27`), never evidence/event visibility (30.3 discovery §16). |
| Course archived | Unaffected — instructor retains read access (§7); `Course.status = ARCHIVED` does not remove the row or its `instructorId`. |
| Course deleted | **Cannot happen** — no application route deletes a `Course`, confirmed again this session (30.3 discovery §1/§41, `grep -rnE "\.(course)\.delete(Many)?\(" src --include="*.ts"` outside tests: zero hits) and `Enrollment.courseId` is `ON DELETE RESTRICT`, so a course with any enrollment cannot be hard-deleted. |
| Quiz/Assignment deleted | **Can happen today**, and does silently (30.3 discovery §1/§16's live, reachable lesson-delete cascade: `QuizAttempt`/`AssignmentSubmission` rows are `ON DELETE CASCADE`d when their parent lesson is deleted). The evidence row and its history survive (no FK from `SkillEvidence` to `Quiz`/`Assignment` — `sourceId` is a free-form string, not a real FK). `sourceContext.courseTitle` resolution (§6/§11) will fail to resolve past the deleted quiz/assignment back to its course in this scenario — see §11 for the display fallback. |
| Source record missing entirely | Same as above — `resolveSourceCourse` (`verification.ts:60-`) already returns `null` for an unresolvable source; the history read model's display-label resolution must handle `null` the same way, falling back to a generic label (§11), never throwing or omitting the row. |
| Verifier/actor account deleted | Already solved by the existing schema design, re-used as-is: `actorId` goes `SetNull` on both event tables, `actorRole` is a plain enum column on both (unaffected by the actor's deletion). `EvidenceStandingEvent` additionally has an `actorName` point-in-time snapshot (`schema.prisma:1319-1325`) that survives the actor's deletion; `SkillProficiencyEvent` has no equivalent field (§5) — a `PROFICIENCY_CHANGED` item whose actor is later deleted shows `actorRole` only, same as it always does (§5), with no degradation, since it never carried a name to begin with. **No new snapshot field needed** — this was already built in 30.3 specifically so `EvidenceStandingEvent` history stays readable after an actor is gone. |

**No new snapshot fields are added in 30.4.** The task's own §11 instruction ("do not add snapshot fields merely because they might be useful later") is satisfied by the schema 30.3 already shipped — `actorName` already exists for exactly this purpose; nothing else in the response contract (§17) requires resurrecting a deleted entity, only displaying its last-known name/title or a graceful "no longer available" label when even that is gone.

---

## 11. Current-state reconciliation

**History explains the projection; it is never a second source of truth, and the API must never compute current proficiency by replaying events.**

```
SkillEvidence  --(projectUserSkill, locked, transactional)-->  UserSkill (current, authoritative)
                                                                     |
SkillProficiencyEvent / EvidenceStandingEvent  <--(written in the SAME transaction)--
        |
        +-- explains how UserSkill got here; read-only, never re-derives it
```

30.4's read functions **must** treat `UserSkill.proficiency`/`.evidenceConfidence` as already-correct for "what is the state now" — the existing `/api/instructor/capability`, `/api/org/capability`, and the learner `/capability` page already answer that question and are **unchanged** by this phase (matching the contract's own L table, "no change from this phase" for those three routes). 30.4 answers a **different** question ("how did we get here"), and must not duplicate or attempt to cross-validate the current-state answer by replaying `seq`/`recordedAt` order client-side — that is exactly the "history becomes an independent source of truth" failure mode task §12 warns against.

**Display-label resolution for `sourceContext` (§5/§10):** resolving a historical event's `courseTitle` requires a **live** lookup through `resolveSourceCourse` at read time (the same function verification already uses), not a stored snapshot — because §6 already established raw source ids are never exposed, and 30.3 deliberately did not add a course-title snapshot field to either event table (unlike `actorName`, which 30.3 did add, specifically because actor identity needed to survive actor deletion in a way source-title does not need to survive source deletion — a deleted quiz's evidence is still valid, contributing evidence per E9, and its title was never needed for anything except display). **Decision: resolve `sourceContext` live, at read time, batched (§20) — not stored, not backfilled.** When resolution fails (§10's deleted-quiz/assignment case), the read model returns `sourceContext: { courseTitle: null }`, and the client renders a generic fallback ("course no longer available") rather than omitting the row or throwing. This is judgment this document is making fresh, since 30.3 did not need to solve it (verification's authorization check already treats an unresolvable source as a hard failure for verify/reject — but a **read**, unlike a **mutation**, must degrade gracefully, not refuse).

**Restated as the §6 privacy rule requires:** this live resolution must go through `resolveSourceCourse`'s existing `sourceId → Course` chain exactly as written today — never a `courseId`/`quizId`-keyed lookup against `Enrollment`/`QuizAttempt` that omits `userId`, which is the precise mechanism D24 (30.3 discovery §1) already proved unsafe.

---

## 12. Ordering

**Checked directly against both the writer code and live data this session — the result contradicts a purely theoretical reading of the schema, so the empirical result is what this document relies on, not the theory.**

Both `SkillProficiencyEvent.recordedAt` and `EvidenceStandingEvent.recordedAt` are declared `@default(now())` in `prisma/schema.prisma` (`:1281`, `:1341`) and compile to `TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP` in the migration SQL (`prisma/migrations/20260924100000_.../migration.sql:53`, `prisma/migrations/20260924180000_.../migration.sql:40`). Neither `verification.ts` nor `proficiency.ts` nor `capabilityBackfill.ts` ever sets `recordedAt` explicitly — `grep -n recordedAt` against all three returns zero matches — so its value always comes from whatever Prisma/Postgres does with that default. Read in isolation, a bare Postgres `CURRENT_TIMESTAMP` column default is transaction-start time, which would predict `recordedAt` landing *before* `occurredAt` (`verification.ts`'s app-computed `now`, captured well into the transaction, after the lock and two prior queries). **That prediction is empirically false.** A direct query against `lumio_test`'s `EvidenceStandingEvent` table (1,579 rows, spanning this whole session's test runs including the `holdSkillEvidenceLock` concurrency tests) found:

```
total: 1579   recordedAt < occurredAt: 0   recordedAt > occurredAt: 1217   recordedAt = occurredAt: 362
max(occurredAt - recordedAt) = 00:00:00   min(occurredAt - recordedAt) = -00:00:00.141
```

**`recordedAt` has never once landed before `occurredAt`, across every row this session's own concurrency tests produced** — it is always equal to or up to 141ms *after* `occurredAt`, the opposite of the transaction-start theory's prediction. A second, independent check against `SkillProficiencyEvent` — every consecutive `(seq, seq+1)` pair for the same `(userId, skillId)`, checking whether the later `seq`'s `recordedAt` ever precedes the earlier one's — also found **zero inversions** across every row in `lumio_test`. This document does not claim certainty about the exact mechanism producing this (whether Prisma materializes `now()` client-side at call time, or some other statement-level behavior) — that was not conclusively isolated this session — but it reports the measured behavior rather than an unverified theory, and design decisions below are based on the measurement, not the theory.

1. **Single-scope ordering (one skill's `SkillProficiencyEvent` sequence; one evidence row's `EvidenceStandingEvent` sequence): use `seq` and `evidenceRevision` respectively, not `recordedAt` — not because `recordedAt` was shown to be unsafe (it wasn't, above), but because these two counters have a *proven*, not merely *observed*, guarantee.** Both are assigned/incremented while holding a `FOR UPDATE` lock held until commit (`UserSkill` for `seq`, `SkillEvidence` for `evidenceRevision`), so two concurrent transactions contending on the same locked row are strictly serialized by construction — no measurement is needed to trust this the way one is needed to trust a timestamp default. This is the stronger, cheaper-to-justify choice, kept as the design even though the empirical checks above found no counterexample to `recordedAt` either.
2. **Cross-entity ordering (all of a learner's skills; org-wide): `(recordedAt, id)`, the only column both tables share with comparable semantics.** No shared lock serializes writes across *different* (user, skill) pairs or *different* evidence rows, so no column — including `recordedAt` — has a construction-level proof of cross-row commit-order safety the way `seq`/`evidenceRevision` do for the single-row case; a retrospective query (like the ones above) observes intra-row chronology, never commit order, which a completed transaction's row leaves no trace of. **A concrete, code-level reason a gap between `recordedAt` and actual commit exists, stated precisely rather than left abstract:** in `applyEvidenceTransition`, the `EvidenceStandingEvent` insert (`verification.ts:303`, where `recordedAt` is stamped) happens *before* the subsequent `projectUserSkill` call, which itself takes a second `FOR UPDATE` wait on the `UserSkill` row (`proficiency.ts`) before the whole transaction can commit — so a real, non-zero interval between `recordedAt`'s stamp and the transaction's actual commit exists by construction on every single write, not merely as a theoretical possibility. **The precise, bounded consequence for a "newest first, load more" feed:** a transaction that stamps `recordedAt` earlier but is still inside that post-stamp work when a page is fetched will not yet be visible (correct, ordinary read-committed behavior); if it then commits after the caller has already paged past where its `recordedAt` sits, it will appear in the *already-viewed* range on any subsequent fetch (a page re-fetched, or the live feed refreshed) rather than at the top of "load more" — **the row is never lost or corrupted, only potentially missed by a single forward-only "load more" pass that does not later refresh from the top.** This is the same class of risk `adminAssignments.ts`'s existing, shipped cursor pagination already carries on `LearningAssignment.createdAt` (`prisma/migrations/20260920200000_add_learning_assignments/migration.sql:37`, the identical `@default(now())` declaration). **Decision: match that existing convention** for the cross-entity views — not a new risk 30.4 introduces, and not fixable without changing a writer, which is out of this discovery phase's scope (§31's slicing table explicitly excludes any writer change).

**Direction:** descending (newest first) for both — matches every existing paginated list in this codebase. **Not configurable** in 30.4 — no product need identified for oldest-first browsing.

---

## 13. Pagination

**Cursor pagination, following the capability domain's own established convention — not the learning-path domain's shared-utility convention.** Two live conventions exist in this repository (found by the inventory pass): `instructorReport.ts`/`organizationReport.ts` each define their own small, private `encodeCursor`/`decodeCursor` pair, deliberately not shared, with an explicit comment justifying the duplication as keeping "two different authorization scopes" decoupled (`instructorReport.ts:43-47`). `learning-path`'s `listing.ts`, by contrast, exports one shared cursor utility reused by three files. **Decision: 30.4 follows the capability-domain convention** (duplicate the small, pure pair once per read function/authorization-scope), because 30.4 itself has (at minimum) two distinct authorization scopes — learner-self and instructor-owned-scope/org-tenant-wide — exactly the situation `instructorReport.ts`'s own comment describes as the reason to keep them decoupled.

**Cursor contents**, per view, per §12's corrected ordering rule:
- `SkillProficiencyEvent`, single-skill view: `{seq: number, id: string}`.
- `SkillProficiencyEvent`, cross-skill/org view: `{recordedAt: string (ISO), id: string}`, subject to §12's stated narrow limitation.
- `EvidenceStandingEvent`, single-evidence view: `{evidenceRevision: number, id: string}`.
- `EvidenceStandingEvent`, cross-evidence (learner/org) view, and the combined timeline (§18): `{recordedAt: string (ISO), id: string}`, same limitation.

**Page size:** `DEFAULT_LIMIT = 50`, `MAX_LIMIT = 100` — reusing the exact constants `instructorReport.ts`/`organizationReport.ts` already use (`instructorReport.ts:32-33`), not inventing new numbers with no basis. The route layer re-validates the requested `limit` against `MAX_LIMIT` before calling the domain function, returning 400 on an out-of-range value.

**Before/after:** not needed — every existing consumer of this pattern in the repo is "load more," strictly older, never "jump back to newer." 30.4 follows suit.

**Stability under concurrent inserts, precisely bounded, not oversold:** guaranteed for the single-skill/single-evidence views (`seq`/`evidenceRevision`, §12) by the lock-serialization argument above. For the cross-entity views, guaranteed against every hazard **except** the narrow transaction-start-vs-commit race §12 names — the event tables are append-only (never updated in place, contract F4), so no row can change status or disappear between pages; the only open risk is a very-late-committing row landing behind an already-issued cursor, the same risk `adminAssignments.ts` already carries today.

**Opaque, integrity-unprotected cursors — matching existing convention, not adding new protection:** neither existing cursor implementation in this repo HMACs or signs its cursor payload; a malformed cursor is simply rejected (decode throws a typed error → 400). 30.4 matches this — the cursor only ever encodes a position, never an authorization decision (§21/§22 elaborate on why cursor tampering is a correctness, not a security, concern here).

---

## 14. Filtering

**Learner:** `skillId` (single value), `type` (the event-type discriminator, §17 — `PROFICIENCY_CHANGED` / `EVIDENCE_STANDING_CHANGED`), date range (`occurredAt` — decided in §15). No `evidenceId` filter (a learner wanting one evidence row's full history already gets it via the skill filter plus a small page; a dedicated single-evidence endpoint is not justified by any question in §2).

**Instructor / ORG_ADMIN:** all of the above, plus `userId` (a specific learner — already validated against the authorization scope, §7/§8, not a free client-suppliable filter that bypasses it) and `evidenceId` (useful for "show me everything that happened to this one piece of evidence I'm reviewing," a real instructor workflow adjacent to `EvidenceReviewList.tsx`'s existing verify/reject UI — and, for the instructor route specifically, already folded into the mandatory authorization predicate per §7's corrected pagination design, so this filter is effectively "narrow the already-authorized set to one id," never a bypass).

**Explicitly not built:** free-text search over `reason`, arbitrary boolean query composition, a generic "any field, any operator" filter API (§30's overengineering review).

---

## 15. Date semantics

- **Storage:** UTC, via Prisma's `DateTime` — unchanged, matches every other timestamp in this schema.
- **Which timestamp is authoritative for ordering/filtering:** `seq`/`evidenceRevision` for single-scope views, `recordedAt` for cross-entity views (§12/§13) — never `occurredAt` for ordering, since `occurredAt` can be genuinely backdated for `SkillProficiencyEvent` (business time) and a backdated row must not destabilize keyset pagination.
- **`occurredAt` is still returned in the response** (§4/§5's item shapes) as the "when did this actually happen" business-time field the learner/instructor cares about — a *display* field, not an *ordering* field (contract F9).
- **Date-range filter (§14) applies to `occurredAt`**, not `recordedAt` — a caller asking "what happened in March" means business time, not write time.
- **Inclusivity:** `[from, to)` — `from` inclusive, `to` exclusive.
- **Timezone/display:** server never converts to a local timezone — client display responsibility, unchanged repository-wide convention.

---

## 16. API surface

**Existing capability API route inventory** (confirmed this session): `GET /api/capability/recommendations` (self-scoped), `POST /api/capability/evidence/[evidenceId]/verify` (the transition mutation), `GET /api/instructor/capability` + `/[learnerId]` (INSTRUCTOR, cursor-paginated), `GET /api/org/capability` (ORG_ADMIN, cursor-paginated). No existing route can be safely extended to also serve history — each already has a settled, narrower response shape (current state only) — so this document does not need to invent a route structure from nothing; the contract's own §L table already reserves distinct new paths for this phase (`GET /api/capability/history`, `GET /api/instructor/capability/[learnerId]/history`).

**Proposed structure**, classified per the task's own request:

| Route | Class | Authorization | Notes |
|---|---|---|---|
| `GET /api/capability/history` | Learner | `requireAuthContext` + `requireTenant`; no additional role restriction | Self-scoped only (§4) — `skillId`/`type`/date-range filters (§14), cursor pagination (§13) |
| `GET /api/instructor/capability/[learnerId]/history` | Instructor | `requireRole(ctx, ["INSTRUCTOR"])`; ownership + soft-delete exclusion enforced inside the domain function (matching `getInstructorLearnerRoles`'s existing "ownership check lives inside the domain function, not the route" convention) | Course-owned-evidence scope only (§7), authorization-filtered **before** the page is cut (§7's corrected design) — 404 (not 403) when `learnerId` does not resolve to an instructor-authorized, non-deleted learner |
| `GET /api/org/capability/[learnerId]/history` | ORG_ADMIN | `requireRole(ctx, ["ORG_ADMIN"])` — SUPER_ADMIN excluded, no exception (§9) | Tenant-wide (§8), no course-ownership narrowing, soft-deleted learners excluded (§8) |

**Route-vs-query-param for the learner-id dimension:** follows the existing `[learnerId]` path-segment convention already used by `/api/instructor/capability/[learnerId]`, for both instructor and org routes — a required, explicit part of the URL, matching the primary expected drill-down use case (§2's questions are all phrased "a learner's...").

**SUPER_ADMIN:** no dedicated route, and no access through the ORG_ADMIN route either (§9).

---

## 17. Response contract

Stable, versioned-by-construction shape:

```
{
  items: HistoryItem[]     // discriminated union, see §18
  nextCursor: string | null
}
```

No top-level `hasMore` boolean separate from `nextCursor` being non-null — matching `instructorReport.ts`/`organizationReport.ts`'s own convention (`nextCursor: string | null` alone), the more directly relevant same-domain precedent, over `adminAssignments.ts`'s `{hasMore, nextCursor}` pair.

**Error responses**, matching the existing `AuthContextError`/`CapabilityVerificationError`-style mapping every route in this domain already uses:
- 401 — not authenticated
- 400 — no tenant, invalid cursor (a new `HistoryCursorError`, same shape as `InstructorCapabilityCursorError`/`AssignmentCursorError`), invalid filter value
- 403 — role not permitted (e.g. STUDENT hitting the instructor route)
- 404 — `learnerId` does not resolve within the caller's authorized, non-deleted scope (§7/§8/§21)

**Nullable fields:** `reason` — an allowlist, not a pass-through (§4/§6): non-null only for `EVIDENCE_REVOKED`/`EVIDENCE_REINSTATED` causes and `REVOKE`/`REINSTATE` actions, forced `null` for every other value regardless of what the underlying row holds (closes the `BASELINE`-metadata leak, §6). `actorRole` (null for system-caused rows — none exist yet, expire/supersede have no writer until 30.8). `actorName` — only meaningful on `EVIDENCE_STANDING_CHANGED` items (`EvidenceStandingEvent` has the field; `SkillProficiencyEvent` does not, §5) — always absent/omitted on `PROFICIENCY_CHANGED` items, not merely nullable. `sourceContext.courseTitle` (null when unresolvable, §10/§11). `evidenceId` on a `PROFICIENCY_CHANGED` item (null for `BASELINE`/`RECALCULATED` causes — contract F6's own existing nullability, and per §7 these are invisible to the instructor's filtered view specifically).

**Display labels:** `cause`/`action` enums are returned as-is, not pre-translated to English strings server-side, matching how every other enum in this codebase's API responses is already handled.

---

## 18. Combined timeline decision

**Both a combined view and type-preserving separation — not a forced either/or, because the two are the same mechanism at the response-shape level.**

The single response envelope (§17) returns `items: HistoryItem[]` as a **discriminated union**:

```
type HistoryItem =
  | ({ type: "PROFICIENCY_CHANGED" } & LearnerProficiencyHistoryItem-shaped fields)
  | ({ type: "EVIDENCE_STANDING_CHANGED" } & LearnerEvidenceStandingHistoryItem-shaped fields)
```

A single query against `GET /api/capability/history` naturally interleaves both event types in one chronologically-ordered feed, **while every item retains its own semantic type** — a client can filter, group, or render each type differently. The `type` filter (§14) lets a caller request only one kind when that's what they need.

**Merge mechanics, simplified from an earlier draft.** The combined query is two separate keyset-paginated queries (one per table), merged by comparing `recordedAt` — the one column both tables share with directly comparable semantics (§12 already established neither table's counter-based key, `seq`/`evidenceRevision`, is globally comparable across skills or evidence rows, so `recordedAt` is the only usable merge key). **One `(recordedAt, id)` cursor, applied identically to both underlying queries, is sufficient** — an earlier draft proposed a cursor that separately captured "both underlying positions," which is unnecessary complexity: since both tables are keyset-paged on the identical `(recordedAt, id)` shape, a single shared cursor value correctly bounds both queries at once (`WHERE recordedAt < cursor.recordedAt OR (recordedAt = cursor.recordedAt AND id < cursor.id)`, applied to each table's query independently, then the two result sets interleaved and cut to `limit`). This inherits §12's stated cross-entity ordering limitation (not a new one introduced by merging) and requires no more implementation complexity than a single-table cursor.

---

## 19. Performance

**Indexes, inspected directly this session:**

`SkillProficiencyEvent` (`schema.prisma:1283-1287`): `@@unique([userId, skillId, seq])`, `@@unique([evidenceId, evidenceRevision])`, `@@index([tenantId, skillId, recordedAt])`, `@@index([tenantId, userId, skillId, recordedAt])`, `@@index([tenantId, cause, recordedAt])`. **The learner single-skill query (`tenantId, userId, skillId`, ordered by `seq`) is covered by the unique constraint on `[userId, skillId, seq]` directly** — no new index needed. The instructor/org cross-skill query (`tenantId, userId`, ordered by `recordedAt`) is **not** directly covered — the existing `[tenantId, userId, skillId, recordedAt]` index requires `skillId` as a leading/equality column before `recordedAt` becomes useful for ordering across skills. **Flagged, not fixed in this discovery pass** (schema changes are out of scope): a future migration adding `@@index([tenantId, userId, recordedAt])` would directly serve the "all my skills, newest first" query shape.

`EvidenceStandingEvent` (`schema.prisma:1343-1345`): `@@unique([evidenceId, evidenceRevision])`, `@@index([tenantId, evidenceId, recordedAt])`, `@@index([tenantId, userId, recordedAt])`. **The learner cross-skill query is directly covered** by `[tenantId, userId, recordedAt]`. The single-evidence view (§12/§13) is directly covered by the `[evidenceId, evidenceRevision]` unique constraint. **A skill-filtered query is not covered by any index** — neither index leads with `skillId`. **Same recommendation as above: flagged for a future migration** (`@@index([tenantId, userId, skillId, recordedAt])`, matching `SkillProficiencyEvent`'s own equivalent) — not built now.

**Cardinality estimate:** unmeasured directly (no production access, §26), but boundable from the D24 empirical run's own numbers (`docs/PHASE_30.3_D24_REMEDIATION.json`): `lumio_test` has ~14,000 `SkillEvidence` rows across ~11,000 tenants. `EvidenceStandingEvent` starts empty (30.3 discovery §27) and only accumulates rows from live verify/reject/unverify/reopen/revoke/reinstate calls since 30.3 shipped — likely small relative to `SkillProficiencyEvent` for the foreseeable future. **No index/partitioning strategy beyond the two flagged additions above is justified by current or reasonably-projected volume.**

---

## 20. N+1 prevention

**A real, live anti-pattern already exists in this codebase and must not be copied.** `getReviewableEvidenceForInstructor` (`verification.ts:411-457`) fetches a student's full `SkillEvidence` list, then calls `resolveSourceCourse(row)` **once per row in a loop** (`verification.ts:441`) — a genuine N+1. **[code, confirmed this session, flagged as an anti-pattern in the inventory pass too]** Acceptable today only because it is bounded to one student's evidence set (small N); a history endpoint's authorization pre-filter (§7) needs the same source-resolution work at potentially larger scale and must not repeat the pattern.

**Design, following the batched-load convention this codebase already uses correctly elsewhere** (`instructorReport.ts`/`organizationReport.ts`'s own pattern: fetch a page of primary rows, then batch-fetch every related row with a single `findMany({where: {id: {in: [...]}}})` per related type, then join in memory via a `Map`):

1. **For the instructor route (§7):** fetch the learner's full `SkillEvidence` id/`sourceType`/`sourceId` list once (bounded — one learner's evidence, same small-N shape `getReviewableEvidenceForInstructor` already safely handles), group by `sourceType`, batch-resolve each group's source courses in one `findMany` per group (at most 3 queries — `Course`, `Quiz`, `AssignmentSubmission`'s join chain), filter to instructor-owned, yielding the authorized `evidenceId` set **before** any event query runs.
2. Fetch the page of event rows, `WHERE evidenceId IN (authorizedIds)` (§7), plus the cursor/tenant predicates.
3. Batch-fetch `Skill` names for the page's distinct `skillId`s: one `findMany`.
4. Batch-fetch display-label source context (§11) for the page's distinct evidence rows, grouped by `sourceType` exactly as step 1 — reusing the same resolution, not a second N+1.
5. Join everything in memory via `Map`s, exactly the existing `instructorReport.ts` pattern.

This bounds the query count to a small constant per request, independent of page size — no actor query is needed for `EvidenceStandingEvent` items (`actorName` is already snapshotted on the row itself, §5/§10); `PROFICIENCY_CHANGED` items carry no name field at all (§5), so there is nothing to resolve for them either. **Recommendation for a later phase, not 30.4's scope:** `getReviewableEvidenceForInstructor` itself could adopt this same batching; fixing existing code is outside this discovery document's scope.

---

## 21. Tenant isolation

Every query in every proposed function (§16) filters by `tenantId` as an explicit, always-present predicate — never inferred from a joined FK alone, matching the existing convention's own explicit comment (`instructorReport.ts`/`organizationReport.ts`: "Course.tenantId = tenantId is enforced as an explicit defense-in-depth predicate alongside instructorId — never trust ownership alone to imply tenant scope").

**Never "load by id, then check tenant"** — the exact anti-pattern 30.3's own D23 fix eliminated from `verification.ts`. **30.4's queries must bake `tenantId` (and `userId`/authorization-scope, where applicable) into the `WHERE` clause of the primary fetch itself**, never as a post-fetch filter or a separate existence check.

**Foreign-tenant resource → same not-found behavior as missing**, restated as 30.4's own instance of the rule 30.3 already fixed: a cross-tenant `learnerId` on the instructor/org history routes (§16) must 404, identical to a nonexistent one — matching `getInstructorLearnerRoles`'s existing `null → 404` convention exactly.

---

## 22. Security review

| Threat | Mitigation |
|---|---|
| Learner changing `userId`/`tenantId` query parameter | **No such parameter exists** on the learner route (§16) — `ctx.userId`/`ctx.tenantId` only. |
| Instructor accessing unrelated learner | 404 via the same authorized-scope-returns-null-or-throws pattern `getInstructorLearnerRoles`/`getReviewableEvidenceForInstructor` already use (§7/§21). |
| Instructor accessing unrelated skill | Not a separate check — authorization is evidence-row-level (§7), so an "unrelated skill" is just evidence outside the pre-filtered authorized id set (§20). |
| ORG_ADMIN accessing foreign tenant | Structurally impossible — `ctx.tenantId` comes from the authenticated session, never a request parameter. |
| SUPER_ADMIN misuse | No route exists for SUPER_ADMIN at all (§9) — not the ORG_ADMIN route, not a dedicated one. |
| Event ID enumeration | Event-row `id`s are never returned in the response (§6/§17) — nothing to enumerate against. |
| Cursor tampering | A tampered/forged cursor cannot grant access to another tenant/scope's rows — every query re-applies the full authorization predicate independent of cursor contents (§13/§21); a malformed cursor is simply rejected (400). |
| Deleted-user access | Excluded by design for instructor/ORG_ADMIN (§7/§8/§10, corrected this pass); moot for the learner (cannot authenticate, §10). |
| Deleted-source access | Handled gracefully — §10/§11's `sourceContext: {courseTitle: null}` fallback; access authorization was already checked against the evidence's own `tenantId`/`userId` and (for instructor) the source's *resolved* course, never trusted from the (now-gone) source itself. |
| Actor identity leakage | §5/§6's explicit, role-gated field table. |

**No capability transition or read in this design trusts client-supplied tenant or user identity anywhere** — none of the functions this document proposes takes `tenantId`/`userId` as a request parameter for the primary subject (only `learnerId` as an explicitly re-validated path segment for instructor/org, never trusted bare).

---

## 23. Current capability profile integration

**Not implemented in 30.4.** Recommendation for whichever phase does build the UI: **link, not merge** — a new "History" tab/section on the existing `/capability` page (learner) and the instructor/org equivalents, fetching from the new endpoints (§16) independently of the existing current-state fetch — keeps the existing, already-tested current-state path completely unchanged. Not designed further here.

---

## 24. Instructor/admin integration

Same posture as §23 — not implemented, linked-not-merged recommended: a "history" affordance on `EvidenceReviewList.tsx` (instructor) and the org capability learner drill-down, both additive, neither requiring a change to the existing verify/reject button flow or the existing report queries. Not designed further here.

---

## 25. AI implications

**AI may read history as context; the API is not designed for AI specifically, and none of this phase's design choices change if AI is removed from consideration entirely** — matching contract K1's existing boundary.

If a future AI context module (mirroring `instructorCopilotContext.ts`/`organizationCopilotContext.ts`, which today read only *current* capability state) wants recent history, it would call the **same** learner/instructor/org history functions this document specifies, through the **same** authorization boundary (contract K2, I4). **No separate AI history API is built or proposed.** Bounded-recent-events is a **query pattern** (a small `limit`), not a new capability.

**D24 caveat applies here too, explicitly:** any AI-generated explanation of a learner's capability history that reads `occurredAt`-derived facts must not be presented as more trustworthy than the underlying data actually is — see §26 for the full statement.

---

## 26. D24 implications

Restated precisely, as the task's own §27 requires, not softened. The underlying risk was already identified, not discovered here — this document's own contribution is narrower: confirming that the remediation actually shipped in 30.3 did not close it.

- **Local D24 remediation is complete for `SkillEvidence.occurredAt`**, but not for every occurrence of the contaminated value that was ever copied elsewhere. `docs/PHASE_30.3_IMPLEMENTATION.md` §18/§28: 11,260 tenants checked in `lumio_test`, 6 `SkillEvidence` rows repaired, reconciliation `unexplained: 0`.
- **30.3 discovery §1 already flagged that `BASELINE` `SkillProficiencyEvent.occurredAt` inherits the same wrong value** — its exact words, quoted here rather than restated: "the `BASELINE` `SkillProficiencyEvent`'s own `occurredAt` (for a row whose backfill also ran) inherits the same wrong value." **What this document adds, checked directly this session, is that the remediation as actually implemented left that already-flagged risk unaddressed**, not merely undocumented: `grep -n BASELINE docs/PHASE_30.3_IMPLEMENTATION.md` returns zero matches — the implementation report never discusses `BASELINE` rows anywhere, in the remediation section or elsewhere. **[code, this session]** `capabilityBackfill.ts:309-311,331-351` confirms why: the `BASELINE` backfill writer sets `occurredAt: earliestOccurredAt ?? row.createdAt`, where `earliestOccurredAt` is derived directly from `contributing.map(e => e.occurredAt)` — i.e., from `SkillEvidence.occurredAt`, the exact field D24 affected. The Phase 30.2 `BASELINE` backfill ran (and `lumio_test`'s existing `BASELINE` rows were written) **before** this session's D24 fix and remediation, and `SkillProficiencyEvent` is append-only (contract F4), while D24's remediation was deliberately scoped to `SkillEvidence` only (`docs/PHASE_30.3_IMPLEMENTATION.md`'s own `classifyAndRepairOne` design, "content-only... never calls `projectUserSkill`"), never touching `SkillProficiencyEvent`. **Consequence: any `BASELINE` row in `lumio_test` (and, once backfill and remediation both eventually run there, potentially in production) whose contributing evidence was contaminated at backfill time carries a wrong `occurredAt` permanently, with no remediation path built or run against it** — the already-known risk was never actually closed, only the `SkillEvidence` half of it was.
- **Neon remediation has not run** — `docs/PHASE_30.3_IMPLEMENTATION.md` §25, literal line `Production D24 remediation: NOT RUN`. This document does not change that, does not run it, and does not touch Neon.
- **History reads must not imply production (or, per the finding above, even fully-remediated local) `occurredAt` correctness.** A 30.4 UI surfacing `occurredAt`-derived facts for a `PROFICIENCY_CHANGED` item with `cause: "BASELINE"` is reading a value that may never be correctable without a new, deliberate `SkillProficiencyEvent`-targeted remediation this document does not specify (out of scope — no schema/production code change permitted here).
- **No production migration is introduced in this phase** — confirmed: this document's own deliverable is `docs/PHASE_30.4_DISCOVERY.md` only (§31/gate).

**Recommendation for whatever phase ships 30.4's implementation:** the response contract (§17) is unaffected (it returns whatever `occurredAt` the row holds, correct or not), but UI copy for a `BASELINE`-caused item should avoid implying precision — a "history begins here" framing is more honest than a specific, possibly-wrong date, matching 30.3 discovery §27's own "audit history begins at first-30.3-transition" framing for `EvidenceStandingEvent`'s empty start. **A dedicated `SkillProficiencyEvent.occurredAt` remediation for already-written `BASELINE` rows is flagged here as real, out-of-scope follow-up work — recorded so it is not lost, matching how D24 itself was originally flagged in the 30.3 discovery before being fixed.**

---

## 27. Auditability

**Read access to history is not itself audited in 30.4.** Reasoning, directly against the task's own explicit instruction not to auto-create an audit event for every GET:

- The two tables this phase reads are **themselves** the audit trail for capability changes — auditing *reads* of an audit trail is a different, separate concern that no other read endpoint in this codebase does today.
- `AdminAuditLog` is structurally unfit for this even if it were desired — no `tenantId` column, a closed action enum unrelated to "read capability history" (30.3 discovery §26).
- **If a future compliance requirement emerges**, it should reuse whatever the platform's eventual sensitive-data-access logging mechanism is (none exists yet) — not a bespoke table invented for capability history alone.

**Decision: no read-access auditing in 30.4.** Recorded as a deliberate choice with its reasoning, not a silent omission.

---

## 28. Testing contract

**Authorization:**
- Learner reads own history — success, correct scope.
- Learner cannot read another user's history — structurally impossible per §4 (no parameter to attempt), but a test should still assert the route ignores any attempt to smuggle a different user via request body/headers.
- Instructor reads an authorized learner's history (shared enrollment + owned-course evidence) — success, correctly scoped to owned-course evidence only.
- Instructor attempts an unauthorized learner (no shared enrollment) — 404.
- Instructor attempts a soft-deleted learner they previously shared an enrollment with — 404, not a partial/empty-but-200 result (§7/§10's corrected rule, this is the specific regression test for the defect this revision found and fixed).
- Instructor attempts an authorized learner but with an unrelated skill/evidence — excluded from the result set AND the page is correctly sized (not short/empty due to post-fetch filtering, §7/§20 — a dedicated pagination-correctness test, not merely an authorization test).
- ORG_ADMIN reads any active learner in their own tenant — success, tenant-wide.
- ORG_ADMIN attempts a soft-deleted learner — 404 (§8's corrected rule).
- ORG_ADMIN attempts a foreign-tenant `learnerId` — 404, not 403 (§21).
- SUPER_ADMIN attempts the ORG_ADMIN route — 403, confirming no implicit broadening (§9's corrected rule).

**Ordering:**
- Single-skill `SkillProficiencyEvent` view ordered by `seq` under concurrent writes (reusing `proficiency.concurrency.test.ts`'s existing barrier pattern).
- Single-evidence `EvidenceStandingEvent` view ordered by `evidenceRevision` under concurrent writes (reusing `holdSkillEvidenceLock`, 30.3's own barrier).
- No dedicated "`recordedAt` is unreliable" test — §12's empirical check found no counterexample, and `applyEvidenceTransition`'s first statement is the `FOR UPDATE` lock itself, with no hook to deterministically force a begin-before-lock-wait ordering inversion in a test. The positive `seq`/`evidenceRevision` concurrency tests above are what prove the ordering choice, not a demonstrated `recordedAt` failure.
- Cross-skill/org view ordered by `recordedAt`, documented limitation accepted, not tested for the narrow race itself (matching `adminAssignments.ts`'s own precedent of not testing that specific class of race either).

**Pagination:**
- First page, next cursor, empty page, invalid cursor — standard cases.
- Stable pagination after insert, for both counter-based (seq/evidenceRevision) and timestamp-based (recordedAt) cursor types, run separately.
- Combined-timeline merge boundary (§18) — a page that straddles both source tables merges correctly, in true `recordedAt` order.
- **Instructor route: a page stays correctly sized after authorization filtering** (§7/§20's fix) — a learner with a mix of authorized and unauthorized evidence, fetched across multiple pages, never returns a short page with more data available, and `nextCursor` accurately reflects the authorized set only.

**Filtering:**
- `skillId`, `type`, date range — each in isolation and combined.
- Instructor/org `userId`/`evidenceId` filters, each re-validated against the caller's authorization scope.

**Privacy:**
- No `tenantId` in any response item.
- No raw `actorId` in any response item, any role.
- Learner response never contains `actorName` — a dedicated test.
- No unauthorized evidence appears in an instructor's filtered result.
- Deleted-source behavior — `sourceContext.courseTitle: null`, row still present.
- `BASELINE`/`RECALCULATED` proficiency events never appear in the instructor's `evidenceId`-filtered view (§7's stated consequence) — a dedicated test, since this is an easy thing to silently regress if the filter is later loosened.
- A `BASELINE` item's `reason` is `null` in the response, even against a fixture whose underlying `SkillProficiencyEvent.reason` row is the real, non-null migration-metadata string (§6's found-and-closed leak) — a regression test for the specific defect this revision found, not merely a documented rule.

**Current-state integrity:**
- A history read (any role, any filter) never writes to `UserSkill`, `SkillEvidence`, or either event table.

**Performance:**
- No N+1: assert query count stays constant as page size grows from 1 to `MAX_LIMIT`.

---

## 29. Mutation testing

If mutation testing is applied to 30.4's implementation, target:

- Every tenant predicate in every query — a mutant removing `tenantId` from a `WHERE` clause must be killed by a cross-tenant test.
- Every authorization predicate (§7/§8/§9's course-ownership, tenant, soft-delete-exclusion, and "no SUPER_ADMIN route" checks) — a mutant weakening any of them must be killed by the corresponding authorization test in §28.
- **The instructor pre-filter's `evidenceId IN (...)` predicate specifically** — a mutant that removes it (reverting to post-fetch filtering) must be killed by the pagination-correctness test in §28, not merely an authorization test (a post-fetch-filter mutant can still pass a "no unauthorized rows appear" test while failing a "page stays correctly sized" test — the two are different failure modes, both needed).
- Ordering/cursor boundary logic — a mutant flipping `<` to `<=`, or swapping the ordering column (`seq`/`evidenceRevision` for `recordedAt`, or vice versa) in a single-scope view, must be killed.
- Event-type discrimination (§18) — a mutant that mislabels an item's `type` field must be killed.
- Filtering predicates — a mutant that drops a filter clause must be killed.

Meaningful survivors investigated per this session's own established discipline — not run in this discovery pass (no implementation exists yet to mutate).

---

## 30. Overengineering review

| Idea | Classification | Reason |
|---|---|---|
| Event sourcing (replay history to derive current state) | **Rejected** | §11 — `UserSkill` stays the sole authoritative current-state cache. |
| Generic audit-query engine (arbitrary field/operator search) | **Rejected** | §14/§27 — a narrow, justified filter set only. |
| Generic timeline framework (reusable across non-capability domains) | **Rejected** | The combined-timeline merge (§18) is specific to these two tables' known shapes — not abstracted into a reusable utility. |
| Configurable history retention | **Rejected** | Both event tables are append-only with no existing deletion path (contract B4/F4) — retention is "forever," not configurable. |
| Complex search syntax | **Rejected** | §14. |
| Analytics warehouse / aggregate rollups | **Rejected** | Contract N table already reserves this for Phase 30.7. |
| AI-specific history storage/API | **Rejected** | §25 — AI reuses the same authorized functions. |
| Per-tenant history policy | **Rejected** | Matches contract D17's existing posture — no product requirement found for tenant-configurable history behavior. |
| Read-access audit logging for history itself | **Deferred, not rejected** | §27 — no mechanism exists to hang it on yet. |
| New composite indexes on the two event tables | **Deferred, not rejected** | §19 — two specific, justified additions identified, not built in this discovery pass. |
| `BASELINE`-row `occurredAt` remediation | **Deferred, not rejected** | §26 — a real, newly-found gap, out of scope for a discovery-only phase; flagged for explicit follow-up rather than silently accepted as permanent. |

---

## 31. Implementation slicing

| Slice | Scope |
|---|---|
| **30.4.0** | Domain read models + pure transform functions (§4/§5/§6/§18's discriminated union shape) + authorization primitives (learner-self, instructor-owned-scope, org-tenant-wide, all soft-delete-exclusion-aware — §4/§7/§8/§9), built and unit-tested against fixtures, no API route yet. |
| **30.4.1** | `GET /api/capability/history` (learner) — the simplest scope, single-table-or-merged per §18, cursor pagination (§13), N+1-safe batching (§20) proven here first. |
| **30.4.2** | `GET /api/instructor/capability/[learnerId]/history` — adds the course-ownership pre-filter (§7's corrected, filter-before-page design), reusing 30.4.1's pagination/merge/batching machinery. |
| **30.4.3** | `GET /api/org/capability/[learnerId]/history` — adds tenant-wide scope (§8), the simplest authorization addition since it needs no per-row filter, only the tenant + soft-delete predicate. |
| **30.4.4** | Filtering (§14) and the two flagged index additions (§19), if real query-plan measurement against `lumio_test`-scale data shows they're needed. |

**Explicitly NOT in 30.4:** UI integration (§23/§24), read-access auditing (§27), AI-specific tooling (§25), any schema/index change (§19/§30), SUPER_ADMIN access of any kind (§9), Neon/production remediation of any kind including the newly-found `BASELINE` `occurredAt` gap (§26), and **no change to any writer** (`verification.ts`, `proficiency.ts`, `capabilityBackfill.ts`) — every ordering/pagination decision in §12/§13 works within what today's writers already produce, never by adding a new column, a new sequence, or changing when/how `recordedAt`/`occurredAt` is set.

---

## 32. Open decisions requiring explicit approval

| ID | Decision | Recommendation |
|---|---|---|
| D25 | Whether `SkillProficiencyEvent`'s `contributing` json snapshot is exposed to the learner as a convenience `contributingEvidenceIds` field, or omitted until a concrete UI need asks for it | **Recommend omit for 30.4.0-30.4.3**, add only when a consuming UI slice needs it (§4, §30) |
| D26 | Whether the two flagged index additions (§19) are built as part of 30.4's own migration, or deferred to a later performance-hardening pass once real query-plan data justifies them | **Recommend defer to 30.4.4**, measured, not assumed |
| D27 | Whether read-access to sensitive history should eventually be logged, and if so, through what mechanism | **Not decided here** — deferred (§27), revisit only if a concrete compliance requirement emerges |
| D28 | Whether a dedicated remediation for already-written `BASELINE` `SkillProficiencyEvent.occurredAt` rows (§26's new finding) is worth a future phase's scope, given it can never be fixed by re-running D24's existing `SkillEvidence`-only remediation | **Recommend a future phase evaluate it once production D24 remediation actually runs**, since the production magnitude of the underlying contamination is itself still unmeasured (§26) — premature to scope a fix for an unmeasured problem |

None of these four block the gate below — each has a stated default recommendation, matching 30.3 discovery's own precedent of "open, but not a blocker" items.

---

## 33. Final recommended contract (30.4 scope only)

1. `SkillProficiencyEvent` and `EvidenceStandingEvent` remain separate, never merged at the storage or transform level — the response contract's discriminated union (§18) preserves the distinction all the way to the client, even in a combined timeline.
2. Three authorization scopes, each reusing an already-locked, already-shipped pattern rather than inventing a new one: learner-self (§4), instructor-owned-evidence-source with authorization-before-pagination (§7, corrected this pass), ORG_ADMIN-tenant-wide (§8). Both instructor and ORG_ADMIN exclude soft-deleted learners, matching contract E6 exactly (§7/§8/§10, corrected this pass — an earlier draft had ORG_ADMIN backwards). No manager hierarchy, no SUPER_ADMIN access of any kind (§9, corrected this pass).
3. Cursor pagination, following the capability domain's own per-scope-duplicated encode/decode convention (§13), ordered by `seq`/`evidenceRevision` (single-skill/single-evidence views — lock-serialized, genuinely stable) or `(recordedAt, id)` (every cross-entity case, with an honestly-stated, narrow, pre-existing-in-this-codebase ordering limitation — §12, corrected this pass from an overstated "stable by construction" claim).
4. `UserSkill` remains the sole authoritative current-state cache; history explains it, never recomputes it (§11). Source-context display labels are resolved live, batched (§20), through the exact `resolveSourceCourse` chain already in production — never a `courseId`/`quizId`-only lookup, the precise shape of D24's own bug (§6).
5. A narrow, justified field-exposure table (§5/§6) — no raw ids, no tenant echo, no raw source ids, actor identity gated by role, `reason` an explicit allowlist rather than a pass-through (closing a real internal-metadata leak on `BASELINE` rows found this revision), `actorName` scoped correctly to the one table that actually has it — governs both event types, differently in what each role and each item type sees.
6. Batched, N+1-safe loading (§20) is a requirement, not an optimization — the existing `getReviewableEvidenceForInstructor` per-row-`resolveSourceCourse` pattern is explicitly named as the anti-pattern 30.4 must not repeat, and the instructor route's authorization pre-filter must run **before** the page is cut, not after (§7, a defect this revision found in its own first draft and fixed).
7. No schema change, no migration, no UI, no AI-specific API, no read-access audit logging, no production/Neon access of any kind ships with this phase.
8. D24's production status is restated, not resolved, by this phase — and a new, previously-undocumented consequence is added: already-written `BASELINE` `SkillProficiencyEvent.occurredAt` rows are not fixed by D24's existing remediation and cannot be, without new, out-of-scope work (§26).

---

## 34. Final gate

Approved with the scope narrowed exactly as this document specifies: 30.4 is domain read models, three authorization-scoped history endpoints, cursor pagination matching this codebase's own capability-domain convention, and a deliberately narrow response contract — not a schema change, not UI, not an AI-specific surface, not read-access auditing, not Neon access of any kind.

This is the second pass of this document; the first contained errors, each corrected here against direct evidence rather than re-reasoned in the abstract: (1) **the `recordedAt` ordering claim was checked with a live `psql` query against `lumio_test`**, not merely read off the schema — the first draft's transaction-start-time theory predicted `recordedAt` would land *before* `occurredAt`; a direct query of 1,579 `EvidenceStandingEvent` rows found the opposite (`recordedAt` never once earlier, usually 0-141ms later), so the design keeps lock-serialized `seq`/`evidenceRevision` for single-scope ordering on the stronger, construction-proof ground rather than the (now corrected) timing claim, and states the cross-entity `recordedAt`-based ordering's residual risk as unquantified and matching an existing, already-accepted repository convention (`adminAssignments.ts`), not as a proven or disproven hazard either way; (2) **the instructor route's authorization filter was redesigned to run before pagination, not after**, matching `adminAssignments.ts`'s own explicit "filter before cut" precedent, closing what would otherwise have been a real short-page/empty-page defect, and its own further consequence (evidence with an unresolvable source is fail-closed out of the instructor's view entirely) is now stated explicitly in §7; (3) **soft-deleted-learner visibility was corrected for both instructor and ORG_ADMIN scopes** against contract E6 and the two existing reports' own already-shipped `deletedAt: null` filters, which the first draft had backwards for ORG_ADMIN, and the `deletedAt` claim itself was re-verified against every production writer of that field, not just the one file first checked; (4) **SUPER_ADMIN's access path was corrected to "none," full stop**, resolving a direct self-contradiction between sections in the first draft; (5) **the D24/`BASELINE` finding's provenance was corrected** — the underlying risk (`BASELINE.occurredAt` inheriting a contaminated value) was already named in 30.3 discovery §1, not new to this document; what this document actually adds, confirmed by grepping `docs/PHASE_30.3_IMPLEMENTATION.md` for zero `BASELINE` mentions, is that the remediation as shipped never closed that already-known gap.

A third pass fixed two further errors, both in the privacy/response-contract categories: (6) **`reason` was changed from a pass-through to an explicit allowlist** after direct confirmation that `capabilityBackfill.ts:342` hardcodes an internal migration-metadata string onto every `BASELINE` row's `reason` field, which §4's original "any cause that happens to carry one" rule would have exposed to the learner verbatim — now non-null only for `EVIDENCE_REVOKED`/`EVIDENCE_REINSTATED`; (7) **`actorName` was corrected to exist only on `EvidenceStandingEvent`, never `SkillProficiencyEvent`** (confirmed against the schema directly, with the citation itself fixed from a wrong line number), and `PROFICIENCY_CHANGED` items were given an explicit `actorRole`-only representation rather than being left silent on actor entirely.

No critical issue remains around tenant isolation (§21), authorization (§7/§8/§9), event ordering (§12, now grounded in two independent live measurements rather than an unverified theory), cursor stability (§13), privacy (§5/§6, the `reason`/`actorName` leaks closed), N+1/performance (§19/§20), deleted-source handling (§7/§10/§11), or response semantics (§17/§18). The open items in §32 are recommendations with stated defaults, not blockers.

```text id="j4q1x8"
PHASE_30.4 IMPLEMENTATION APPROVED
```
