# Lumio V2 Roadmap

**Status:** Canonical roadmap as of 2026-09-10 (end of Phase 4). This document consolidates
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

The first flagship vertical, as established by the actual Phase 1–4 work, is:

**AI Course Creation → AI Learning → Skill Evidence**

Only the first leg (AI Course Creation) is implemented today. "AI Learning" exists partially (AI
Tutor, refactored onto the shared runtime in Phase 3). "Skill Evidence" is schema-only — no
service layer, no emitters (verified: no code path anywhere writes a `SkillEvidence` or
`LearningEvent` row).

---

## 2. Completed Phases

| Phase | Status | What was delivered |
|---|---|---|
| Phase 1 — Domain Foundation | COMPLETE | Capability + Knowledge + AI + Events schema (additive), `AuthContext`, migration generated (not applied) |
| Phase 2 — Knowledge + Permission-Aware RAG | COMPLETE | `KnowledgeSource/Document/Chunk`, versioning, `KnowledgeAccess`, permission-aware retrieval, tutor integration, test infra |
| Phase 3 — AI Runtime | COMPLETE | Shared runtime (`src/lib/ai/runtime/`), policy, context builder, persistence, tutor refactor |
| Phase 3.1 — Execution Reliability | COMPLETE | `createExecutionTracker` — every `AIExecution` reaches a terminal state |
| Phase 4 — AI Course Creator | COMPLETE | Curriculum/content/assessment generation, human review UI, application-only save boundary |

Verified against `git log --oneline`: Phase 1+2 schema work is one commit
(`4b24fb1`/`51e0712` — schema foundation, then knowledge/RAG), Phase 3 + the reliability fix are
**one squashed commit** (`31333e3` — there is no separate "Phase 3.1" commit; it's presented here
as a distinct row because the user's own task framing and `docs/V2_AI_ARCHITECTURE.md` treat it as
a distinct unit of work with its own verification), and Phase 4 is `0a51fe8`.

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
                 │ Capability (schema  │
                 │   only, no service) │
                 │ Knowledge (full RAG │
                 │   service + auth)   │
                 │ AI Runtime (policy, │
                 │   context, persist) │
                 │ Learning Events     │
                 │   (schema only, no  │
                 │   emitter)          │
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
| AI Recommendations | DEFERRED | Future Phase | TBD | LearningEvent emitters | Listed as a future AI workflow ("AI Learning Coach"), not started |
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
| SkillEvidence automation | DEFERRED | Future Phase | TBD | LearningEvent emitters | Schema exists, zero writes anywhere |
| LearningEvent → SkillEvidence pipeline | DEFERRED | Future Phase | TBD | LearningEvent emitters | Design intent only (`docs/V2_DOMAIN_MODEL.md`, "Relationship graph") |
| Skill gaps | DEFERRED | Future Phase | TBD | UserSkill population | `SkillGap` was deliberately **not** added as a table in Phase 1 — intended to be computed from `UserSkill` vs `RoleSkill`, not stored |
| Role/skill recommendations | DEFERRED | Future Phase | TBD | Skill gaps | Not started |
| Capability analytics | DEFERRED | Future Phase | TBD | LearningEvent emitters | Not started |
| Competency frameworks | UNCONFIRMED | — | TBD | — | Not mentioned in any V2 doc or implementation; appears only as a plausible extrapolation — see §6 |

### Analytics

| Item | Status | Intended Phase | Priority | Dependencies | Notes |
|---|---|---|---|---|---|
| Event-driven analytics | DEFERRED | Future Phase | TBD | LearningEvent emitters | `docs/V2_ARCHITECTURE.md` names this as a V2 direction ("Analytics dashboards → event-backed queries") |
| Learner analytics | DEFERRED | Future Phase | TBD | Event-driven analytics | Not started |
| Manager analytics | DEFERRED | Future Phase | TBD | Event-driven analytics | Not started |
| Capability dashboards | DEFERRED | Future Phase | TBD | Capability analytics | Not started |
| AI usage analytics | DEFERRED | Future Phase | TBD | Cost estimation | `AIUsageEvent` rows exist to build this from; no dashboard reads them yet |

### Learning

| Item | Status | Intended Phase | Priority | Dependencies | Notes |
|---|---|---|---|---|---|
| Learning paths | UNCONFIRMED | — | TBD | — | `src/app/api/ai/learning-path/route.ts` exists as a **V1 feature**, predates V2 and is not part of the V2 architecture docs — do not conflate with a V2 "LearningProgram" (design intent only, no code) |
| Adaptive learning | UNCONFIRMED | — | TBD | — | Not mentioned in any V2 doc; plausible extrapolation only — see §6 |
| Recommendations | DEFERRED | Future Phase | TBD | LearningEvent emitters | Named as "AI Learning Coach" in `docs/V2_AI_ARCHITECTURE.md`, "First AI workflows" — not started |
| Certification intelligence | UNCONFIRMED | — | TBD | — | Not mentioned in any V2 doc; a `Certificate` model exists from V1 with no AI layer — see §6 |
| Evidence-driven progression | DEFERRED | Future Phase | TBD | SkillEvidence automation | Design intent only (`docs/V2_DOMAIN_MODEL.md`, "Important invariants") |

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
```

**Verified directly against the repository this task** (`npx prisma migrate status` against the
real Neon `DATABASE_URL`, just now):

```text
Datasource "db": PostgreSQL database "neondb" at "...aws.neon.tech"
11 migrations found in prisma/migrations
Following migration have not yet been applied:
  20260909180000_add_v2_capability_knowledge_ai_foundation
```

**Production migration has NOT been applied.** This is the current, confirmed state — not a stale
claim carried over from an earlier report. The migration was applied once, to a disposable local
Postgres instance only (Phase 2, to prove the full history replays cleanly), and has never
connected to Neon at all.

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
Course Creator Enhancements (picker UIs, content/assessment UI wiring)
       +
AI Search
       +
AI Copilot
       +
Skill Evidence / Capability Loop (needs LearningEvent emitters first)
       ↓
Action / Workflow Layer  (needs AI WRITE/EXECUTE — currently blocked by design guardrail)
       ↓
Agents
```

All items after Phase 4 are `Future Phase` — no exact phase numbers have been decided.

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
3. **Skill Evidence / capability loop** — highest strategic value (it's the third leg of the
   flagship vertical), but has the most missing prerequisites: no `LearningEvent` emitter exists
   anywhere yet, so this would need to start with instrumenting learner/AI actions to emit events
   before evidence can be derived from them. Larger, multi-part effort.
4. **AI Copilot** — `AISurface.COPILOT` exists in the policy table but has no defined product
   surface/UX yet (unlike Search, which has an obvious shape). Needs a product-definition step
   before implementation, not just engineering.
5. **Action/tool foundation** — explicitly the highest-guardrail item: `policy.ts`'s WRITE/EXECUTE
   denial is described as "actively disabled... not merely unimplemented," requiring an explicit
   design review before any code starts. Should come after, not before, the lower-risk items above
   establish more real usage patterns to design tools around.

**Tradeoff summary**: (1) and (2) are extensions of already-proven, already-tested infrastructure
with no new security surface — lowest risk, fastest to ship. (3) is the highest product value but
requires new foundational work (event emission) before it can start. (4) needs product definition
first. (5) is gated by an explicit guardrail and should come last.

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
