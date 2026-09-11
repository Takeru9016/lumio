# Lumio V2 Roadmap

**Status:** Canonical roadmap as of 2026-09-11 (end of Phase 7). This document consolidates
`V2_ARCHITECTURE.md`, `V2_DOMAIN_MODEL.md`, `V2_AI_ARCHITECTURE.md`, `V2_MIGRATION_MAP.md`, and
`V2_DATABASE_MIGRATION.md`, verified against the actual repository (git log, schema, `src/lib/`,
routes, tests) — not copied from prior chat reports without re-checking. Where this document and
one of those others disagree, that is called out explicitly in §12 rather than silently resolved.

This document is the **canonical roadmap** — sequencing, status, deferred work, and guardrails. The
five detailed architecture documents above remain the **canonical technical reference** for their
respective domains; this file summarizes and points to them, it doesn't replace them.

---

## 1. Product Direction

Lumio is evolving from a course-centric LMS into an **AI-native Learning & Capability Platform**,
connecting:

```text
People → Roles → Skills → Knowledge → Learning → Evidence → Outcomes
```

AI is an intelligence and action layer across these systems, not a standalone chatbot
(`docs/V2_ARCHITECTURE.md`, "Product thesis").

Five systems (`docs/V2_ARCHITECTURE.md`, "System boundaries"):

1. **Learning** — courses, modules, lessons, activities, assessments, paths, enrollments, progress, certifications.
2. **Capability** — skills, skill categories, roles, role requirements, user skill profiles, evidence, skill gaps.
3. **Knowledge** — knowledge sources, documents, chunks, embeddings, metadata, permissions, citations.
4. **Intelligence** — AI runtime, model routing, retrieval, tutor, copilot, recommendations, natural-language analytics, agents.
5. **Action** — workflows, approvals, notifications, integrations, audited AI actions.

The first flagship vertical, as established by the actual Phase 1–7 work, is:

**AI Course Creation → AI Learning → Skill Evidence → Recommendations → Capability Visibility**

All legs now have a real implementation. "AI Course Creation" (Phase 4) and "AI Learning" (AI
Tutor, refactored onto the shared runtime in Phase 3) were already implemented. "Skill Evidence" —
the capability loop (Learning → Evidence → Capability) — was implemented in Phase 5. Phase 6 closed
the loop's first consumer (`Capability Gap → Recommended Course`, deterministic, no AI). Phase 7
made the resulting capability state visible to the learner for the first time (`/capability`:
role, required skills, proficiency, gap status, evidence). What remains open is an
analytics/manager-facing layer and an AI explanation layer on top of what now exists — both
deferred (see §4).

---

## 2. Completed Phases

| Phase | Status | What was delivered |
|---|---|---|
| Phase 1 — Domain Foundation | COMPLETE | Capability + Knowledge + AI + Events schema (additive), `AuthContext`, migration generated (not applied) |
| Phase 2 — Knowledge + Permission-Aware RAG | COMPLETE | `KnowledgeSource/Document/Chunk`, versioning, `KnowledgeAccess`, permission-aware retrieval, tutor integration, test infra |
| Phase 3 — AI Runtime | COMPLETE | Shared runtime (`src/lib/ai/runtime/`), policy, context builder, persistence, tutor refactor |
| Phase 3.1 — Execution Reliability | COMPLETE | `createExecutionTracker` — every `AIExecution` reaches a terminal state |
| Phase 4 — AI Course Creator | COMPLETE | Curriculum/content/assessment generation, human review UI, application-only save boundary |
| Phase 5 — Capability & Skill Evidence Foundation / Capability Loop | COMPLETE | Learning-outcome → SkillEvidence → UserSkill projection, instructor/SUPER_ADMIN verification, dynamic capability gaps, `LearningEvent` emission with course-completion concurrency protection |
| Phase 6 — Capability Recommendations | COMPLETE | Deterministic `Capability Gap → Recommended Course` engine (`getRecommendedLearning()`), read-only API, dashboard "Recommended for you" card |
| Phase 7 — Capability Progress / Skill Development View | COMPLETE | Learner-facing `/capability` profile: primary role, required skills, current vs. required proficiency, gap status, evidence visibility |

Verified against `git log --oneline`: Phase 1+2 schema work is one commit
(`4b24fb1`/`51e0712` — schema foundation, then knowledge/RAG), Phase 3 + the reliability fix are
**one squashed commit** (`31333e3` — there is no separate "Phase 3.1" commit; it's presented here
as a distinct row because the user's own task framing and `docs/V2_AI_ARCHITECTURE.md` treat it as
a distinct unit of work with its own verification), and Phase 4 is `0a51fe8`. Phase 5 is `5e81c0b` (`feat: implement phase 5 capability loop`), with
its final-contract-audit fixes (atomic enrollment transition, evidence-verification authorization)
folded into a follow-up commit `bb430e5`. Phase 6 is `a7e68fe` (`feat: implement capability
recommendations engine and integrate into student dashboard`) — its own final-contract-audit
hardening (route-level tests, `GET` signature correction) was folded into the same working tree
before that commit landed, so it carries no separate hash. **Phase 7 has not yet been committed**
as of this roadmap update — implementation, tests, and this documentation update are complete and
verified directly against the working tree (189/189 tests passing, `tsc`/Biome/Prisma clean), but
this file is written and saved immediately before the finalize commit is created, so no hash exists
for it yet at the moment this text is written.

### Phase 1 — Domain Foundation

- **Capability domain**: `Skill`, `SkillCategory`, `JobRole`, `RoleSkill`, `UserJobRole`,
  `UserSkill`, `SkillEvidence`, `CourseSkill` — schema only, `src/lib/domain/capability/types.ts`
  is type re-exports, **no service layer** (verified: file is 19 lines, all `export type`).
- **Knowledge domain (schema)**: `KnowledgeSource`, `KnowledgeDocument`, `KnowledgeChunk`
  (`Unsupported("vector(1536)")` embedding, same pattern as `Lesson.embedding`).
- **AI persistence models**: `AIConversation`, `AIMessage`, `AIToolCall`, `AISourceCitation`,
  `AIExecution`, `AIUsageEvent`.
- **Events**: `LearningEvent` — schema only, **no emitter exists anywhere** (verified by grep).
- **`src/lib/auth/context.ts`**: `AuthContext`/`getAuthContext`/`requireAuthContext`/
  `requireTenant`/`requireRole` — a reusable tenant-scoped identity foundation. Existing routes
  were **not** migrated to it this phase (still inline `auth() → db.user.findUnique → manual
  check`); Phase 4's Course Creator save route is the first consumer.
- **Migration**: `prisma/migrations/20260909180000_add_v2_capability_knowledge_ai_foundation/`,
  generated via offline schema diff, additive only (verified: zero `DROP`/`RENAME`/`TRUNCATE`).
- **Backward compatibility**: zero changes to any existing V1 table's columns/constraints; one new
  nullable FK column on `Lesson` (`knowledgeDocumentId`).

### Phase 2 — Knowledge + Permission-Aware RAG

- `KnowledgeSource` → `KnowledgeDocument` → `KnowledgeChunk`, with document versioning
  (`activeVersion`/`version`, atomic flip after a full re-index — see `ingestion.ts`).
- `KnowledgeAccess` model + `KnowledgeAccessScope` (TENANT/TEAM/USER), `KnowledgeVisibility`
  (TENANT default / RESTRICTED, fail-closed).
- Tenant isolation and team/user/tenant visibility enforced by `canReadKnowledgeDocument()`
  (pure predicate, `access.ts`) and reproduced inline in SQL by `searchKnowledge()`
  (`retrieval.ts`) — authorization is inside the query, never fetch-then-filter.
- Citations: every result carries `{documentTitle, sourceId}`.
- **Lesson bridge**: `lessonBridge.ts` (`planLessonBackfill`, `backfillLesson`) exists but is
  **not invoked by any route or cron** — a coexistence plan, not a running pipeline.
- Security tests: `access.test.ts`, `ingestion.test.ts`, `retrieval.security.test.ts`.
- Test infrastructure stood up from zero this phase: Vitest + local Postgres 17 + pgvector
  (Homebrew), `src/lib/db.ts` adapter selection by `.neon.tech` substring match.

### Phase 3 — AI Runtime

- `src/lib/ai/runtime/`: `types.ts` (`AISurface`, `AIAction`, `AIRequestContext`,
  `AIRuntimeError`), `policy.ts` (table-driven `isActionAllowed`/`assertActionAllowed`),
  `provider.ts` (`modelFor(surface)`), `context.ts` (`buildAIContext`), `persistence.ts`
  (conversation/message/citation/execution/usage-event writes).
- READ/GENERATE allowed for TUTOR/SEARCH*/COURSE_CREATOR/COPILOT (*SEARCH: READ only, no
  generation step); **WRITE/EXECUTE denied for every surface, unconditionally** — not merely
  unimplemented.
- Knowledge integration: `buildAIContext` calls `searchKnowledge()` when policy/tenant/query allow.
- V2 AI persistence + `AIUsageEvent`, gated on `tenantId` (FREE-plan users get none of this,
  legacy `AIChat`/`aiCallsUsed` unaffected).
- `/api/ai/tutor` refactored (not rewritten) onto the runtime — only route wired to it before
  Phase 4.
- Verified this phase required **zero schema changes** (by test, not assumption:
  `persistence.test.ts`, "the correlation chain closes end-to-end").

### Phase 3.1 — Execution Reliability

- Known gap from Phase 3: a provider/stream failure before `onEnd` could leave `AIExecution`
  permanently `RUNNING`.
- Fixed via `src/lib/ai/runtime/execution.ts`: `createExecutionTracker(executionId, startedAt)` —
  idempotent `markFailed`/`markSucceeded`, safe no-op when no execution was started, persistence
  failures caught internally (never obscure the original model/stream error).
- Wired into `/api/ai/tutor/route.ts` at three call sites (`streamText.onError`,
  `toUIMessageStream.onError`, outer try/catch) and, in Phase 4, into each Course Creator
  generation function via a single try/catch (non-streaming).
- Zero schema changes (confirmed via `git diff --stat prisma/schema.prisma`).

### Phase 4 — AI Course Creator

Implemented workflow: `Define → Generate → Review → Create Draft`
(`src/app/(instructor)/courses/create-ai/page.tsx`).

- **Curriculum generation** (`src/lib/domain/course-creator/generate.ts`) — `AISurface.COURSE_CREATOR`
  / `AIAction.GENERATE`, Knowledge-aware via `searchKnowledge()` (per-document or tenant-wide).
- **Skill suggestions** — model returns skill *names* only, shown as suggestions; never
  auto-created, never auto-linked to real `Skill` rows.
- **Structured validation** — `schema.ts`: bounded arrays, `contentType` restricted to the real
  `LessonType` enum, citations are index-references into a server-built list (never a raw id),
  `correctAnswer` refined to a real option id, `saveDraftInputSchema` is `.strict()` (rejects
  `tenantId`/`userId`/`courseId`/status outright).
- **Human review** — title/description/objectives editable, lessons removable, citations visible.
- **Application-only draft creation** (`saveDraft.ts`) — no import from `src/lib/ai/runtime/*`
  anywhere in the save path; `assertCanCreateCourse()` (`src/lib/domain/course/authorization.ts`,
  extracted from `POST /api/courses`) re-enforces the same instructor-role + plan-limit gate;
  every `targetSkillId` re-verified against the caller's tenant; Course always created `DRAFT`;
  one `db.$transaction`.
- **Lesson content API** (`content.ts`) — structured blocks → allowlisted-tag HTML serializer,
  never raw model HTML. Implemented, **not yet wired into the review UI**.
- **Assessment API** (`assessment.ts`) — MCQ generation matching `Quiz`/`QuizQuestion`. Implemented,
  **not yet wired into the review UI**.
- **AI persistence** — same Phase 3 tables, surface `COURSE_CREATOR` (maps to schema's
  `AIConversationType.COURSE_BUILDER` — a deliberate, documented naming difference, see §8).
- **Security boundary** — 34 new tests (95 total repo-wide): tenant isolation, skill-ownership
  verification, AI policy, model-output validation, save-boundary (role/plan/DRAFT-forced/no
  partial writes), citation correspondence, execution-failure handling.
- Zero schema changes.

### Phase 5 — Capability & Skill Evidence Foundation / Capability Loop

Implements the loop `Learning → Evidence → Capability` (`src/lib/domain/capability/`):
`outcomes.ts`, `proficiency.ts`, `proficiencyOrder.ts`, `verification.ts`, `gaps.ts`, plus
`src/lib/domain/learning-events/emit.ts`.

- **Learning outcome integration** — `recordCourseCompletionOutcome()` wired into
  `POST /api/courses/[courseId]/lessons/[lessonId]/complete`; `recordQuizOutcome()` wired into
  `POST /api/quizzes/[quizId]/attempt`. Both are additive, tenant-gated (no `tenantId` → no
  capability tracking, matching every other V2 write), and never affect the route's existing
  response shape or status behavior.
- **SkillEvidence** — deterministic creation from `CourseSkill` mappings on course completion and
  quiz pass; DB-enforced idempotency via a real unique constraint (`tenantId, userId, skillId,
  sourceType, sourceId` — not an application-level check-then-insert, which cannot close the race
  under Postgres READ COMMITTED); tenant-safe `CourseSkill` resolution (a cross-tenant mapping is
  skipped, not thrown on).
- **UserSkill** — deterministic full recomputation (`projectUserSkill`) over the complete
  non-`REJECTED` evidence set on every change, order-independent; explicit hand-written proficiency
  ordering (never Prisma enum declaration order); ceiling policy is `UNVERIFIED`/`PENDING` →
  `BEGINNER`, `VERIFIED` → `INTERMEDIATE` (`ADVANCED`/`EXPERT` are unreachable in Phase 5 — no
  evidence type or verification state projects to them); rejecting evidence can downgrade
  proficiency (full recompute, not incremental); `lastAssessedAt` only advances when the projected
  proficiency value actually changes; `confidence` is deliberately never written by any Phase 5 code
  path (verified by code inspection and end-to-end test coverage) — no confidence scoring exists
  yet.
- **Verification** — INSTRUCTOR may verify/reject evidence only for courses they own
  (`course.instructorId === actor.userId`, resolved from the evidence's source); SUPER_ADMIN may
  verify/reject any evidence but is still subject to the same source/tenant resolution — an
  unresolvable/malformed source is fail-closed for every actor, SUPER_ADMIN included; self-
  verification and cross-tenant verification are both denied.
- **Capability gaps** — `computeCapabilityGap()` computes `RoleSkill` vs `UserSkill` on read,
  per the user's primary `JobRole` (or an explicit secondary role). No `SkillGap` table exists —
  gaps are never persisted, consistent with the Phase 1 decision recorded in §4's Capability table.
- **LearningEvent** — `COURSE_COMPLETED` and `QUIZ_COMPLETED` events emitted best-effort,
  post-commit (never inside the evidence/`UserSkill` transaction, never rethrown into the caller);
  a `LearningEvent` emission failure cannot roll back or block the underlying capability/completion
  write. Course-completion concurrency is protected by an atomic enrollment-transition gate
  (`db.enrollment.updateMany({ where: { status: { not: "COMPLETED" } } })`) — only the request that
  actually flips the enrollment to `COMPLETED` runs the one-time completion side effects (XP,
  certificate, capability outcome, event emission), closing a duplicate-event race found during the
  Phase 5 final contract audit. `LearningEvent` itself still has no DB-level uniqueness constraint;
  see §7 for the residual scope of that gap.
- **Validation** — 149/149 tests passing (up from 95 at the end of Phase 4), `npx tsc --noEmit`
  zero errors, `npx prisma validate` clean, Biome zero errors on changed files.
- **Schema change** — one new `@@unique([tenantId, userId, skillId, sourceType, sourceId])`
  constraint on `SkillEvidence`, additive only. See §8 for migration/deployment status.
- **Deliberately not built this phase** (do not read as complete — see §4 for full status):
  manager verification, recommendations, dashboards/UI for any of the above, `AIAction.EVALUATION`
  behavior, `LessonSkill`, `AssessmentSkill`, `SkillGap` persistence, a generalized competency
  engine, agents/workflows, assignment-sourced evidence, additional `LearningEvent` types beyond the
  two above, `PENDING` verification-state transitions (evidence is created `UNVERIFIED`, not
  `PENDING`, in Phase 5), and `confidence` semantics/scoring. No generalized RBAC was introduced —
  verification authorization remains one narrow predicate for one action, matching the existing
  assignment-grading route's shape.

### Phase 6 — Capability Recommendations

Implements `Capability Gap → Recommended Learning → Existing Learning Action`
(`src/lib/domain/capability/recommendations.ts`), the first consumer of Phase 5's capability state.

- **Deterministic, relational recommendation engine** — `getRecommendedLearning(ctx)` reuses
  `computeCapabilityGap()` unchanged, joins unmet-gap skills through `CourseSkill` to
  `PUBLISHED` courses in the caller's own tenant only (`Course.tenantId === ctx.tenantId` — never
  `null`, never another tenant, corrected during discovery from an initial assumption that a
  null-tenant course might be globally recommendable; the existing course catalog page never treats
  it that way for a tenant-scoped learner, so neither does this), excludes courses with an
  `ACTIVE`/`COMPLETED` enrollment (`REFUNDED` does not exclude).
- **Ranking** — deterministic 4-key sort: max ordinal proficiency-distance (severity) descending,
  distinct-skill count descending, `Course.createdAt` ascending, `Course.id` ascending as a final
  tie-break. Aggregation and full ranking happen before a `slice(0, 5)` cap — never a raw DB `take`
  before ranking.
- **API** — `GET /api/capability/recommendations`, self-scoped only (`requireAuthContext()` +
  `requireTenant()`, identical pattern to `verify/route.ts`); public response shape is
  `{ courseId, courseTitle, reasonSkills }` — the internal `courseSlug` field (needed only for the
  dashboard's own link) is stripped before the response is sent.
- **Dashboard** — a "Recommended for you" card on the existing student dashboard, calling the
  domain function directly (no client-side fetch to its own API route); empty or errored →
  omitted, never breaks the rest of the dashboard.
- **No AI, no RAG, no embeddings** anywhere in candidate selection or ranking — `AISurface.COPILOT`
  remains unwired, exactly as before this phase.
- **Validation** — 178/178 tests passing (149 at end of Phase 5 + 29 new: 23 domain + 6 route-level).
- **Zero schema changes.**
- **Deliberately not built this phase**: manager recommendations, recommendation persistence/
  history, dashboards beyond the one card, AI-generated explanations, semantic/RAG ranking,
  notifications, a new `LearningEvent` type for "recommendation shown/accepted" (the enum already
  has an unused `RECOMMENDATION_ACCEPTED` value from Phase 1 — still unused after this phase).

### Phase 7 — Capability Progress / Skill Development View

Implements the first learner-facing surface for Phase 5/6's capability state:
`src/app/(student)/capability/`, plus `src/lib/domain/capability/evidence.ts`.

- **`/capability` page** — a self-scoped, read-only profile composing `computeCapabilityGap()`,
  `getUserSkillState()` (both unchanged, reused as-is), and the new `getSkillEvidenceForUser()`.
  Shows the learner's primary role, every required skill (met and unmet alike — `gaps` already
  contains the complete required-skill set, not just the unmet ones), current vs. required
  proficiency, gap status, last-assessed date, and the evidence backing each skill (type, score,
  verification status, date).
- **`getSkillEvidenceForUser(ctx)`** — self-scoped `SkillEvidence` read (`tenantId`/`userId` from
  `ctx` only), deterministic order (`createdAt` desc, `id` asc tie-break).
- **Honest empty states, never a thrown error** — no tenant, no primary role assigned (the existing
  `{ role: null, gaps: [] }` contract, unchanged), and a query failure all render a clear message
  instead of breaking the page; no fake role or invented data is ever shown.
- **Dashboard integration** — one link ("View your skill profile") added to the existing dashboard;
  no capability logic duplicated there.
- **No new API route** — the page is a server component calling domain functions directly, same
  convention as the dashboard.
- **No AI, no new authorization primitive** — self-scoped via the same `AuthContext` pattern as
  every other Phase 5/6 capability read; no manager/instructor/org-admin view was built.
- **Validation** — 189/189 tests passing (178 at end of Phase 6 + 11 new evidence-read tests).
- **Zero schema changes.**
- **Deliberately not built this phase**: manager or instructor/org-admin capability views (a
  discovery pass found the existing `ORG_ADMIN` + `/reports` pattern in `src/lib/reports.ts` would
  make this LOW complexity if pursued later, but it was not pursued in Phase 7), `LearningPlan` or
  any persisted goal, AI capability copilot/explanations, recommendation persistence/history,
  advanced analytics, `SkillGap` persistence, workflows/agents.

---

## 3. Current Architecture

```text
                 ┌─────────────────────┐
                 │   Lumio V1 LMS      │
                 │ Courses / Lessons   │
                 │ Quizzes / Enroll.   │
                 └──────────┬──────────┘
                            │  (unchanged, coexisting)
                            ▼
                 ┌─────────────────────┐
                 │   V2 Foundations    │
                 ├─────────────────────┤
                 │ Capability (full    │
                 │   evidence/gap loop,│
                 │   Phase 5)          │
                 │ Knowledge (full RAG │
                 │   service + auth)   │
                 │ AI Runtime (policy, │
                 │   context, persist) │
                 │ Learning Events     │
                 │   (emitter exists,  │
                 │   COURSE_COMPLETED/ │
                 │   QUIZ_COMPLETED)   │
                 └──────────┬──────────┘
                            │
                            ▼
                 ┌─────────────────────┐
                 │ AI Course Creator   │
                 │ READ + GENERATE     │
                 │ (curriculum/content/│
                 │  assessment)        │
                 └──────────┬──────────┘
                            │
                            ▼
                 ┌─────────────────────┐
                 │ Human Review        │
                 │ (create-ai/page.tsx)│
                 └──────────┬──────────┘
                            │
                            ▼
                 ┌─────────────────────┐
                 │ Application WRITE   │
                 │ (saveDraft.ts — no  │
                 │  AI runtime import) │
                 │ → Course (DRAFT)    │
                 └─────────────────────┘
```

`/api/ai/tutor` is a parallel, separate path through the same AI Runtime + Knowledge layers (not
shown above to keep the Course Creator flow legible) — both consume the identical
policy/context/persistence stack.

The Phase 5 capability loop is a separate flow, triggered by learning outcomes rather than by the
Course Creator path above:

```text
 Lesson/Course completion            Quiz attempt (pass/fail)
          │                                    │
          ▼                                    ▼
 recordCourseCompletionOutcome()      recordQuizOutcome()
          │                                    │
          ├──────────────┬─────────────────────┤
          ▼              ▼                     ▼
   SkillEvidence   UserSkill (full      LearningEvent
   (DB-unique per   recompute via        (COURSE_COMPLETED /
   evidence source) projectUserSkill)    QUIZ_COMPLETED,
          │                              best-effort, post-commit)
          ▼
   Verification (INSTRUCTOR/SUPER_ADMIN)
   → re-triggers UserSkill recompute
          │
          ▼
   computeCapabilityGap() — read-time only, RoleSkill vs UserSkill, never persisted
```

---

## 4. Deferred Work

Statuses used: COMPLETE, NEXT, PLANNED, DEFERRED, BLOCKED, DESIGN DECISION REQUIRED. Priority is
`TBD` everywhere no explicit priority was established in the Phase 1–4 work — none was.

### Course Creator

| Item | Status | Intended Phase | Priority | Dependencies | Notes |
|---|---|---|---|---|---|
| Knowledge-document picker UI | DEFERRED | Future Phase | TBD | none | Domain layer already accepts `knowledgeDocumentIds`; no browsing UI exists |
| Skill picker UI | DEFERRED | Future Phase | TBD | none | Domain layer already accepts `targetSkillIds`; no browsing UI exists for Skills anywhere in the app |
| Lesson-content generation UI integration | DEFERRED | Future Phase | TBD | none | `content.ts` + its route are implemented and tested; only the review page doesn't call them yet |
| Assessment-generation UI integration | DEFERRED | Future Phase | TBD | none | Same situation as lesson-content |
| Automatic AI skill-name → Skill linking | DEFERRED | Future Phase | TBD | Skill picker UI | Explicitly ruled out this phase — "AI suggestions must be suggestions" |
| Lesson-level skill persistence / `LessonSkill` | DESIGN DECISION REQUIRED | Future Phase | TBD | none | No such table exists; would be a genuinely new schema addition, not an extension of Phase 1's `CourseSkill` |
| Richer course-authoring workflow (reorder sections, inline regenerate, etc.) | DEFERRED | Future Phase | TBD | none | Phase 4 spec explicitly said "focused workflow, not a complete replacement" |
| Persistent course draft/version model | DESIGN DECISION REQUIRED | Future Phase | TBD | none | Phase 4 deliberately kept the proposal as client/in-memory state, not a stored draft table — revisit only if a real need for persisted-before-save drafts emerges |

### Knowledge

| Item | Status | Intended Phase | Priority | Dependencies | Notes |
|---|---|---|---|---|---|
| File ingestion connectors | DEFERRED | Future Phase | TBD | none | Only `createTextDocument`/manual ingestion exists (`ingestion.ts`) |
| URL ingestion | DEFERRED | Future Phase | TBD | none | Not started |
| Additional source connectors | DEFERRED | Future Phase | TBD | none | `KnowledgeSourceType` enum has room; no connector code exists |
| Old-chunk cleanup after re-index | DEFERRED | Future Phase | TBD | none | `indexDocument()` never deletes prior-version chunks — documented gap, no cleanup job |
| Document/version lifecycle improvements | PLANNED | Future Phase | TBD | old-chunk cleanup | Versioning mechanism exists (`activeVersion`/`version`); lifecycle policy around it doesn't |
| Dedicated embedding-model fields | DEFERRED | Future Phase | TBD | none | Currently stored as JSON in `KnowledgeChunk.metadata`, flagged in Phase 1 audit as non-blocking |
| Automated Lesson embedding backfill | DEFERRED | Future Phase | TBD | `lessonBridge.ts` wired to a route/cron | `backfillLesson()` exists, callable, not invoked anywhere |
| Production Knowledge backfill | BLOCKED | Future Phase | TBD | migration must be applied to Neon first | Cannot start before the Phase 1/2 migration is applied |
| DB-level composite tenant enforcement | DEFERRED | Future Phase | TBD | none | Sibling-FK tenant agreement (e.g. `RoleSkill` pairing cross-tenant `JobRole`/`Skill`) is application-level only, consistent with pre-existing V1 pattern — not a regression |

### AI Runtime

| Item | Status | Intended Phase | Priority | Dependencies | Notes |
|---|---|---|---|---|---|
| Tool registry | DEFERRED | Future Phase | TBD | none | Design intent documented (`docs/V2_AI_ARCHITECTURE.md`, "Tool registry"); zero code |
| Tool calls | DEFERRED | Future Phase | TBD | Tool registry | `AIToolCall` table exists, zero writes from anywhere |
| `AIToolCall.executionId` | DEFERRED | Future Phase | TBD | Tool calls | Deliberately not added in Phase 1 — "no tool calls exist yet to correlate" |
| AI WRITE actions | BLOCKED | Future Phase | TBD | Tool registry, explicit design review | `policy.ts` denies WRITE for every surface "not merely unimplemented... actively disabled" — flipping this requires a design review per the Phase 3 spec, not just code |
| AI EXECUTE actions | BLOCKED | Future Phase | TBD | AI WRITE actions, approval/confirmation UX | Same guardrail as WRITE |
| Broader AI permission integration | DEFERRED | Future Phase | TBD | none | Policy today is surface × action only — no per-user/per-role override |
| Multi-provider support | DEFERRED | Future Phase | TBD | none | `provider.ts` is explicitly "one seam, not a multi-provider abstraction"; OpenAI only |
| Cost estimation / pricing | DEFERRED | Future Phase | TBD | none | `AIUsageEvent.estimatedCost` field exists, never populated (verified: zero writes set it) |
| Richer AI observability | DEFERRED | Future Phase | TBD | none | Current signal is `AIExecution`/`AIUsageEvent` rows only, no dashboard/aggregation |
| Cross-request AI conversation continuity | DEFERRED | Future Phase | TBD | none | Every request creates a new `AIConversation` — not resumed across requests |
| Route-level AI integration tests | PLANNED | Future Phase | TBD | none | Explicitly limited by design so far — "Do NOT add route-level Clerk mocks merely for this test" was a repeated constraint across Phases 3/3.1/4; domain-layer tests substitute |

### AI Product Surfaces

| Item | Status | Intended Phase | Priority | Dependencies | Notes |
|---|---|---|---|---|---|
| AI Search | PLANNED | Future Phase | TBD | none | `AISurface.SEARCH` exists in policy table (READ-only), no route |
| AI Copilot | PLANNED | Future Phase | TBD | none | `AISurface.COPILOT` exists in policy table, no route |
| AI Recommendations | DEFERRED | Future Phase | TBD | none (LearningEvent emitters now exist as of Phase 5) | Listed as a future AI workflow ("AI Learning Coach"), not started |
| Additional AI Tutor capabilities (standalone, not lesson-scoped) | DEFERRED | Future Phase | TBD | none | Tutor still requires `lessonId` to trigger; not yet "ask anything the tenant has indexed" |
| Course Creator production hardening | NEXT | Future Phase | TBD | none | See §7's "Recommended next" |

### Agents / Action System

| Item | Status | Intended Phase | Priority | Dependencies | Notes |
|---|---|---|---|---|---|
| Agents | DEFERRED | Future Phase | TBD | Tool registry, AI WRITE/EXECUTE | `docs/V2_ARCHITECTURE.md`'s "Action" system — zero code |
| Workflows | DEFERRED | Future Phase | TBD | none | Not started |
| Workflow runs | DEFERRED | Future Phase | TBD | Workflows | Not started |
| Approvals | DEFERRED | Future Phase | TBD | Workflows | Not started |
| Notifications (AI-triggered) | DEFERRED | Future Phase | TBD | Workflows | A `Notification` model exists for other product areas; not wired to AI |
| Integrations | DEFERRED | Future Phase | TBD | none | Not started |
| Autonomous action boundaries | DESIGN DECISION REQUIRED | Future Phase | TBD | AI WRITE/EXECUTE | Explicit design review required per Phase 3 guardrail before any of this starts |

### Capability

| Item | Status | Intended Phase | Priority | Dependencies | Notes |
|---|---|---|---|---|---|
| SkillEvidence automation | **COMPLETE (Phase 5)** | — | — | — | `recordCourseCompletionOutcome()`/`recordQuizOutcome()` — see §2's Phase 5 section |
| LearningEvent → SkillEvidence pipeline | **COMPLETE (Phase 5)** | — | — | — | Course completion and quiz outcomes now both emit evidence and events in the same outcome call |
| Skill gaps | **COMPLETE (Phase 5)** for on-read computation | — | — | — | `computeCapabilityGap()` computes `RoleSkill` vs `UserSkill` at read time; `SkillGap` remains deliberately **not** a table — never persisted, as decided in Phase 1 |
| Role/skill recommendations | **COMPLETE (Phase 6)** | — | — | — | `getRecommendedLearning()` — deterministic, relational, no AI — see §2's Phase 6 section |
| Capability analytics | DEFERRED | Future Phase | TBD | none (LearningEvent emitters now exist as of Phase 5) | Not started |
| Manager verification | DEFERRED | Future Phase | TBD | none | Phase 5 verification is INSTRUCTOR (course-owner) + SUPER_ADMIN only — a manager/reporting-line verifier role was explicitly out of scope |
| Learner capability profile / evidence view | **COMPLETE (Phase 7)** | — | — | — | `/capability` page — see §2's Phase 7 section |
| Manager / instructor / org-admin capability view | DEFERRED | Future Phase | TBD | none | A Phase 7 discovery pass found `src/lib/reports.ts`'s existing `ORG_ADMIN`-gated `getCompletionReport()` pattern would make this LOW authorization complexity if pursued — not built in Phase 7 |
| `LearningPlan` / persisted capability goals | DEFERRED | Future Phase | TBD | none | Evaluated during Phase 7 discovery and judged premature — no product signal yet that a stored goal (vs. a live-computed gap) is needed |
| AI capability copilot / explanations | DEFERRED | Future Phase | TBD | Capability profile UI (now satisfied by Phase 7) | `AISurface.COPILOT` exists in policy table, unwired; Phase 6/7 discovery explicitly deferred AI until deterministic capability UX existed to explain — it now exists, but AI wiring was not started |
| `AIAction.EVALUATION` (AI-assisted evidence evaluation) | DEFERRED | Future Phase | TBD | AI WRITE/EXECUTE review | Not started; Phase 5 evidence/verification is entirely non-AI |
| `LessonSkill` / `AssessmentSkill` (lesson- and assessment-level skill granularity) | DESIGN DECISION REQUIRED | Future Phase | TBD | none | Phase 5 evidence resolves only at the `CourseSkill` level, per the locked Phase 5 contract; no such tables exist |
| `confidence` semantics / scoring | DEFERRED | Future Phase | TBD | none | `UserSkill.confidence` exists in schema but is deliberately never written by Phase 5 — no scoring model defined yet |
| `PENDING` verification-state transitions | DEFERRED | Future Phase | TBD | none | Phase 5 evidence is created `UNVERIFIED`; nothing transitions evidence into `PENDING` |
| Competency frameworks | UNCONFIRMED | — | TBD | — | Not mentioned in any V2 doc or implementation; appears only as a plausible extrapolation — see §6 |

### Analytics

| Item | Status | Intended Phase | Priority | Dependencies | Notes |
|---|---|---|---|---|---|
| Event-driven analytics | DEFERRED | Future Phase | TBD | none (LearningEvent emitters now exist as of Phase 5, `COURSE_COMPLETED`/`QUIZ_COMPLETED` only) | `docs/V2_ARCHITECTURE.md` names this as a V2 direction ("Analytics dashboards → event-backed queries") |
| Learner analytics | DEFERRED | Future Phase | TBD | Event-driven analytics | Not started |
| Manager analytics | DEFERRED | Future Phase | TBD | Event-driven analytics | Not started |
| Capability dashboards | DEFERRED | Future Phase | TBD | Capability analytics | Not started |
| AI usage analytics | DEFERRED | Future Phase | TBD | Cost estimation | `AIUsageEvent` rows exist to build this from; no dashboard reads them yet |

### Learning

| Item | Status | Intended Phase | Priority | Dependencies | Notes |
|---|---|---|---|---|---|
| Learning paths | UNCONFIRMED | — | TBD | — | `src/app/api/ai/learning-path/route.ts` exists as a **V1 feature**, predates V2 and is not part of the V2 architecture docs — do not conflate with a V2 "LearningProgram" (design intent only, no code) |
| Adaptive learning | UNCONFIRMED | — | TBD | — | Not mentioned in any V2 doc; plausible extrapolation only — see §6 |
| Recommendations | DEFERRED | Future Phase | TBD | none (LearningEvent emitters now exist as of Phase 5) | Named as "AI Learning Coach" in `docs/V2_AI_ARCHITECTURE.md`, "First AI workflows" — not started |
| Certification intelligence | UNCONFIRMED | — | TBD | — | Not mentioned in any V2 doc; a `Certificate` model exists from V1 with no AI layer — see §6 |
| Evidence-driven progression | DEFERRED | Future Phase | TBD | none (SkillEvidence automation delivered in Phase 5) | Design intent only (`docs/V2_DOMAIN_MODEL.md`, "Important invariants") — evidence now exists, but nothing yet consumes it to gate/adapt learning progression |

---

## 5. Potential Future Capabilities

These appeared in the task's own prompt as items to evaluate, but were **never established as
planned or deferred** by any V2 document or by the Phase 1–4 implementation. Listed separately so
they aren't misread as approved roadmap items:

- **Competency frameworks** — no V2 doc mentions this term; `Skill`/`SkillCategory` exist but no
  framework/standard-mapping concept.
- **Adaptive learning** — no V2 doc mentions this; would require `LearningEvent` emitters and a
  recommendation engine that don't exist yet.
- **Certification intelligence** — no V2 doc mentions AI involvement with `Certificate`; the model
  exists purely as a V1 feature.
- **Learning paths as a V2 concept** — `docs/V2_DOMAIN_MODEL.md` names `LearningProgram`/
  `LearningProgramItem` as design intent ("Still not implemented" list), but the *existing*
  `/api/ai/learning-path` route is a pre-V2 feature using `Course`/`Lesson` directly, not the same
  thing. Don't conflate the two when scoping future work.

---

## 6. Architectural Decisions / Guardrails

These are established decisions from Phases 1–4, not open questions. Any future phase must
preserve them unless the user explicitly authorizes a change (per §11's change-control rule).

### AI autonomy

```text
READ      → allowed
GENERATE  → allowed
WRITE     → denied (actively disabled, not merely unimplemented)
EXECUTE   → denied (actively disabled, not merely unimplemented)
```

AI does not directly mutate `Course`/`Section`/`Lesson`/`Skill` data anywhere in the codebase.
Enforced by `src/lib/ai/runtime/policy.ts`'s table, verified by `policy.test.ts` and, in Phase 4,
by the structural fact that `saveDraft.ts` imports nothing from `src/lib/ai/runtime/*`.

### Knowledge security

Knowledge retrieval must always be permission-aware and tenant-scoped. Never:

```text
retrieve everything → filter afterward
```

Authorization (tenant match, `status = READY`, visibility/access-row check) is inlined directly
into the SQL `WHERE` clause of `searchKnowledge()` — the same query that ranks and limits results.
No candidate chunk is ever fetched before Postgres evaluates the predicate.

### Human approval

AI proposes/generates. Human/application code writes. Demonstrated in Phase 4: every generation
route returns a proposal; only `save/route.ts` (which never touches the AI runtime) persists a
`Course`.

### Migration

V2 migration remains additive. Do not remove, until an explicit migration plan exists:

- `Lesson.embedding`
- `AIChat`
- `User.aiCallsUsed`

All three are still live and unchanged as of Phase 4.

### Existing LMS

V1 and V2 coexist during migration — verified true for every phase so far (zero V1 route/behavior
changes except the two narrow, behavior-preserving refactors in §8: `src/lib/db.ts`'s adapter
selection and `POST /api/courses`'s authorization extraction).

### AI provider

OpenAI remains the current provider (`@ai-sdk/openai`, via `modelFor()`).

### Vector database

Neon/Postgres + pgvector remains the current vector infrastructure (production); a local
Postgres 17 + pgvector instance is used for tests only, never for production traffic.

### Auth

Clerk remains the authentication source of truth.

---

## 7. Known Technical Debt / Risks

Only issues actually identified during Phases 1–4.

| Item | Impact | Blocks future work? | Intended resolution |
|---|---|---|---|
| DB-level sibling-FK tenant consistency not enforced (e.g. `RoleSkill` could pair a `JobRole` and `Skill` from different tenants) | Low — every write path that matters (`ingestion.ts`, `saveDraft.ts`) enforces this in application code; a direct/manual DB write could violate it | No | Consistent with pre-existing V1 pattern (e.g. `MandatoryTraining`); revisit only if a real incident occurs |
| No automatic old-chunk cleanup after re-index | Low — storage growth only, no correctness issue (old versions are simply invisible to retrieval, not deleted) | No | Deferred — see §4 Knowledge table |
| AI conversation continuity not implemented (new `AIConversation` per request) | Medium for UX (no multi-turn memory across page loads at the persistence layer) — the client still sends full message history, so *chat* continuity works; only the *persisted* conversation record doesn't span requests | No | Deferred — see §4 |
| `AIUsageEvent.estimatedCost` not computed | Low — no pricing table exists; field is simply always null | No | Deferred — needs a pricing table, not invented speculatively |
| Route-level AI integration tests are limited | Medium for confidence in full request/response wiring — domain-layer tests are thorough (95 tests), but no route-level Clerk-mocked test exists for any `/api/ai/*` route | No | Deliberate: "Do NOT add route-level Clerk mocks merely for this test" was a repeated, explicit constraint — not an oversight |
| Test database setup is manual/local, not scripted | Low — reproducible by a documented sequence (`docs/V2_DATABASE_MIGRATION.md` §10), but not a single command | No | A `docker-compose.test.yml` was named as the natural next step if this becomes recurring friction — not done |
| `COURSE_CREATOR` (runtime `AISurface`) vs `COURSE_BUILDER` (schema `AIConversationType`) naming mismatch | Low — deliberate and documented (`persistence.ts`'s `surfaceToConversationType`), not a bug | No | Revisit only if/when `SEARCH`/`COPILOT` ship real routes and need their own schema value |
| Lesson-content/assessment generation routes exist but aren't wired into the Course Creator UI | Medium for product completeness of the Phase 4 vertical | No (routes are independently tested and functional) | Recommended next — see §9 |
| Knowledge-document/Skill picker UI don't exist | Medium — Course Creator's Knowledge-aware and Skill-suggestion generation can't be fully exercised through the UI yet, only via direct API calls | No | Recommended next — see §9 |
| `LearningEvent` has no DB-level uniqueness constraint | Low — `SkillEvidence`/`UserSkill` (the actual capability state) are unaffected; only the `LearningEvent` audit/analytics stream could theoretically double-write under concurrency, and nothing currently consumes `LearningEvent` | No | Course-completion duplication is already closed by the atomic enrollment-transition gate (Phase 5). Quiz events don't need dedup by design — each `QuizAttempt` legitimately emits its own event. A DB-level constraint remains a candidate if a future analytics consumer needs it, not applied speculatively |

---

## 8. Database / Migration Status

```text
Phase 1:
  Schema changes: YES (9 enums, 18 tables, 1 new column on Lesson)
  Migration: generated (20260909180000_add_v2_capability_knowledge_ai_foundation)
  Applied to Neon: NO

Phase 2:
  Schema changes: YES (2 enums, 1 table, 3 new columns, 1 changed unique constraint)
  Migration: folded into the SAME Phase 1 migration directory (not a second migration)
  Applied to Neon: NO

Phase 3:
  Schema changes: NO (verified by test)

Phase 3.1:
  Schema changes: NO (verified by git diff)

Phase 4:
  Schema changes: NO (verified by git diff)

Phase 5:
  Schema changes: YES (1 unique constraint on SkillEvidence: tenantId, userId, skillId,
    sourceType, sourceId — the real concurrency guarantee against duplicate evidence,
    an application-level check-then-insert cannot close this race under Postgres
    READ COMMITTED)
  Migration: generated (20260911000000_add_skill_evidence_uniqueness)
  Applied to Neon: NO
  No additional schema change was introduced for LearningEvent — course-completion
    concurrency is closed at the application layer (atomic enrollment transition),
    not via a new LearningEvent constraint (see §7)

Phase 6:
  Schema changes: NO (verified by git diff — pure read-only recommendation engine)

Phase 7:
  Schema changes: NO (verified by git diff — pure read-only capability profile view)
```

**Verified directly against the repository this task** (`npx prisma migrate status` against the
real Neon `DATABASE_URL`, just now):

```text
Datasource "db": PostgreSQL database "neondb" at "...aws.neon.tech"
12 migrations found in prisma/migrations
Following migrations have not yet been applied:
  20260909180000_add_v2_capability_knowledge_ai_foundation
  20260911000000_add_skill_evidence_uniqueness
```

**Production migration has NOT been applied — for either pending migration.** This is the current,
confirmed state — not a stale claim carried over from an earlier report. Both the Phase 1/2
migration and the Phase 5 migration exist only as generated SQL files in `prisma/migrations/`; the
Phase 1/2 migration was applied once, to a disposable local Postgres instance only (Phase 2, to
prove the full history replays cleanly), and neither migration has ever connected to Neon. There is
an **implemented migration file** for Phase 5; there is **no deployment of it** — do not conflate
the two.

---

## 9. Phase Dependency Map

```text
Phase 1 (Domain Foundation)
  ↓
Phase 2 (Knowledge + Permission-Aware RAG)
  ↓
Phase 3 (AI Runtime)
  ↓
Phase 3.1 (Execution Reliability)
  ↓
Phase 4 (AI Course Creator)
  ↓
Phase 5 (Capability & Skill Evidence Foundation / Capability Loop) — COMPLETE
  ↓
Phase 6 (Capability Recommendations) — COMPLETE
  ↓
Phase 7 (Capability Progress / Skill Development View) — COMPLETE
  ↓
Course Creator Enhancements (picker UIs, content/assessment UI wiring)
       +
AI Search
       +
AI Copilot / capability-explanation layer (now has a deterministic UI to explain,
  as of Phase 7 — still not started)
       +
Manager / instructor / org-admin capability view (de-risked by the existing
  ORG_ADMIN + reports.ts pattern — still not started)
       +
Capability analytics / dashboards
       ↓
Action / Workflow Layer  (needs AI WRITE/EXECUTE — currently blocked by design guardrail)
       ↓
Agents
```

All items after Phase 7 are `Future Phase` — no exact phase numbers have been decided.

---

## 10. Recommended Next

Not approved — evaluated candidates only, per the actual completed architecture.

1. **Course Creator UX completion (RECOMMENDED NEXT)** — wire the already-implemented,
   already-tested `content.ts`/`assessment.ts` routes into `create-ai/page.tsx`, and build the
   Knowledge-document/Skill picker UIs. Lowest risk: zero new domain/security surface, the hard
   authorization work is already done and tested. Directly completes the Phase 4 vertical instead
   of opening a new one.
2. **AI Search** — `AISurface.SEARCH` already exists in the policy table (READ-only); would be a
   thin route over `searchKnowledge()`, similar shape to Course Creator's Knowledge integration.
   Low-medium effort, no schema changes expected.
3. ~~**Skill Evidence / capability loop**~~ — **COMPLETE as of Phase 5.** Learning outcomes now
   produce `SkillEvidence`, deterministic `UserSkill` proficiency, instructor/SUPER_ADMIN
   verification, and on-read capability gaps. Recommendations (Phase 6) and the learner profile
   view (Phase 7) are now also complete — see items 6/7 below. What remains (manager verification,
   capability analytics) is tracked in §4's Capability table.
4. **AI Copilot** — `AISurface.COPILOT` exists in the policy table but has no defined product
   surface/UX yet (unlike Search, which has an obvious shape). Needs a product-definition step
   before implementation, not just engineering.
5. **Action/tool foundation** — explicitly the highest-guardrail item: `policy.ts`'s WRITE/EXECUTE
   denial is described as "actively disabled... not merely unimplemented," requiring an explicit
   design review before any code starts. Should come after, not before, the lower-risk items above
   establish more real usage patterns to design tools around.
6. ~~**Capability surfacing (recommendations)**~~ — **COMPLETE as of Phase 6** (deterministic
   `Capability Gap → Recommended Course` engine + dashboard card).
7. ~~**Capability surfacing (learner profile view)**~~ — **COMPLETE as of Phase 7** (`/capability`
   page: role, required skills, proficiency, gap status, evidence).
8. **Manager / instructor / org-admin capability view (RECOMMENDED NEXT for the capability
   vertical)** — a Phase 7 discovery pass confirmed this is lower-risk than it first appears:
   `src/lib/reports.ts`'s existing `getCompletionReport(tenantId, filters)` + the `ORG_ADMIN`-gated
   `/reports` page is a directly reusable authorization/aggregation pattern — no new role, no new
   permission primitive needed if scoped to `ORG_ADMIN`. Would require new aggregate domain code
   (today's `computeCapabilityGap`/`getUserSkillState` are hard-scoped to `ctx.userId`, not "any
   user in the tenant").
9. **AI capability copilot** — `AISurface.COPILOT` exists in the policy table, unwired. Now has a
   deterministic capability UI (Phase 7) to explain, which was the explicit precondition Phase 5/6/7
   discovery repeatedly named before considering this. Still needs a product-definition pass for
   what it explains and how.
10. **`LearningPlan` / persisted capability goals** — evaluated and explicitly rejected as premature
    during Phase 7 discovery; no product signal yet justifies persisting a goal separate from the
    live-computed gap. Revisit only if a real need for tracked/dismissable goals emerges.

**Tradeoff summary**: (1) and (2) are extensions of already-proven, already-tested infrastructure
with no new security surface — lowest risk, fastest to ship. (3), (6), and (7) are done. (4)/(9)
need product definition first, and (9) additionally needs (7) as a precondition (now satisfied).
(5) is gated by an explicit guardrail and should come last. (8) is the natural next step in the
capability vertical — its authorization risk is now known to be low, reusing an existing pattern,
but it is still new aggregate domain code, not merely a UI layer over existing self-scoped
functions the way (6)/(7) were. (10) stays deferred until a concrete need appears.

---

## 11. Change Control

Any future Claude Code implementation phase should:

1. Read `docs/V2_ROADMAP.md`.
2. Inspect the actual repository (schema, `src/lib/`, routes, tests) — do not rely solely on this
   document or prior chat reports for implementation status.
3. Identify the relevant roadmap item from §4/§9/§10.
4. State the intended phase explicitly before implementing.
5. Preserve existing architectural guardrails (§6) — especially the WRITE/EXECUTE denial and the
   human-approval boundary.
6. Avoid implementing unrelated roadmap items in the same phase.
7. Update this roadmap when a milestone is completed or a plan changes — move the row in §4 to §2,
   or update its status.

This document is the canonical roadmap. The five detailed architecture documents
(`V2_ARCHITECTURE.md`, `V2_DOMAIN_MODEL.md`, `V2_AI_ARCHITECTURE.md`, `V2_MIGRATION_MAP.md`,
`V2_DATABASE_MIGRATION.md`) remain the canonical technical references for their respective domains.

---

## 12. Consistency Notes / Uncertainties

Discovered during this audit, not silently resolved:

- **Phase numbering mismatch, already flagged in the docs themselves**:
  `docs/V2_MIGRATION_MAP.md`'s own "Phase 2 — Course Builder" / "Phase 3 — Learner Intelligence"
  sections use a different numbering scheme than the conversational task's "Phase 1/2/3/3.1/4"
  labels used throughout this roadmap and in every prior report. Both documents already contain
  explicit notes about this mismatch rather than silently renumbering either — this roadmap
  preserves that same policy and uses the conversational numbering (matching what the user has
  used in every phase-kickoff message) since that's what this document's audience refers to it by.
- **`/api/ai/learning-path`** is a pre-V2 (V1) feature. It is easy to misread as part of the V2
  "Learning" system given the name overlap with `LearningProgram` design intent — they are not the
  same thing (see §5).
- **No explicit priority values exist anywhere in the V2 documentation** for any deferred item —
  every priority in §4 is `TBD` because none was ever established, not because it was omitted here.
- **"Phase 3.1" has no distinct commit** — it's part of the same commit as Phase 3
  (`31333e3`). Presented as its own row/section because the conversational task and
  `docs/V2_AI_ARCHITECTURE.md` both treat it as a distinct, separately-verified unit of work (own
  test file, own "Updated" note in the error-handling table).
- **Phase 5 is `5e81c0b`**, with final-contract-audit fixes in follow-up commit `bb430e5`. (This
  roadmap previously stated Phase 5 had no commit hash yet — corrected once the commit existed.)
- **Phase 6 is `a7e68fe`**, with no separate hash for its final-contract-audit hardening (route-level
  tests, `GET` signature fix) — those changes were folded into the working tree before that commit
  landed, so they were never a distinct commit to reference.
- **Phase 7 had no commit hash at the time this section was written** (see the note in §2) — this
  roadmap update and the Phase 7 implementation are committed together immediately afterward.
