# Lumio V2 Migration Map

## Current → V2

| Current | V2 direction | Migration treatment |
|---|---|---|
| User | User + membership/permissions | Keep User; add authorization layer |
| Tenant | Tenant | Keep |
| Team | Team | Keep |
| Course | LearningProgram + Course | Additive compatibility mapping |
| Section | Module | Additive mapping |
| Lesson | Activity | Additive mapping |
| LessonProgress | ActivityProgress + LearningEvent | Keep operational state; emit events |
| Quiz | Assessment | Keep initially; map forward |
| QuizQuestion | AssessmentItem | Additive mapping |
| Assignment | Assessment/Activity | Additive mapping |
| Certificate | Credential/Certificate | Keep; extend later |
| AIChat | AIConversation + AIMessage | Backfill and dual-read during migration |
| Lesson.embedding | KnowledgeChunk.embedding | Re-index; keep legacy column temporarily |
| aiCallsUsed | AIUsageEvent/usage ledger | Dual-write, then derive quota |
| XPTransaction | LearningEvent-derived gamification | Keep for compatibility |

## File/service migration

### Keep

- Existing Next.js App Router structure.
- Prisma/Postgres/pgvector.
- Clerk authentication.
- Mux video infrastructure.
- UploadThing file handling.
- Upstash rate limiting.
- Existing design tokens and component primitives.

The current package uses Next 16, React 19, Prisma 7, AI SDK 7, Clerk 7 and related infrastructure; this is a strong base for incremental V2 work.

### Refactor

- `src/lib/ai/search.ts` → knowledge retrieval service with authorization-aware filters. **Status:**
  the new service (`src/lib/domain/knowledge/retrieval.ts`) exists and is authorization-aware, but
  `search.ts` itself has NOT been refactored/replaced — it's untouched, and `/api/ai/tutor` calls
  both additively (see Phase 3 status above).
- `src/lib/ai/middleware.ts` → shared AI request/policy context.
- AI route handlers → thin adapters around the shared runtime.
- Role checks → permission checks where appropriate.
- Analytics dashboards → event-backed queries.

### Deprecate later

- Lesson-only RAG as the canonical retrieval strategy.
- JSON-only AIChat as the long-term conversation store.
- User-level integer AI usage as the sole quota source.
- Feature-specific AI prompt/route implementations that duplicate runtime concerns.

## Implementation sequence

### Phase 0 — Baseline

- Add V2 architecture/domain/AI docs.
- Define permission vocabulary.
- Define event taxonomy.
- Define database naming conventions.

### Phase 1 — Foundation

**Status: schema + auth foundation implemented (2026-09-09). Migration generated, not applied. No routes/UI migrated.**

- Added Skill, SkillCategory, JobRole, RoleSkill, UserSkill, UserJobRole, SkillEvidence, CourseSkill. **Not added: SkillGap** — deferred, computable from UserSkill.proficiency vs RoleSkill.requiredProficiency without a stored table; revisit once a real read pattern needs it.
- Added KnowledgeSource, KnowledgeDocument, KnowledgeChunk. Embedding lives directly on `KnowledgeChunk` via the same `Unsupported("vector(1536)")` approach as `Lesson.embedding` — no separate `Embedding` model.
- Added AIConversation, AIMessage, AIToolCall, AISourceCitation, AIExecution, AIUsageEvent. **Not added: AIAgentRun** — deferred to Phase 5 (Automation), no agents exist yet to run.
- Added LearningEvent.
- Added `src/lib/auth/context.ts` (`AuthContext`/`getAuthContext`/`requireAuthContext`/`requireTenant`/`requireRole`) as the reusable tenant-scoped identity foundation. Existing routes still use their own inline `auth() -> db.user.findUnique -> manual check` pattern (e.g. `src/app/api/org/branding/route.ts`) — none were rewritten this phase.
- Added type-only domain folders: `src/lib/domain/{capability,knowledge,learning}/types.ts`, `src/lib/analytics/types.ts`. No service layer — re-exports of Prisma types plus a couple of composite types, per the "no speculative business logic" rule for this phase.
- Migration `prisma/migrations/20260909180000_add_v2_capability_knowledge_ai_foundation/` generated via offline schema-diff (see `docs/V2_DATABASE_MIGRATION.md`). **Not applied to the Neon database.**

### Phase 2 — Course Builder

**Not implemented.** Note: the conversational task that drove this session called its own work
"Phase 2: Knowledge + Permission-Aware RAG Foundation" — that work actually corresponds to this
document's **Phase 3 (Learner Intelligence)** bullet "Rebuild tutor on knowledge-layer retrieval"
below (partially: retrieval + auth foundation done, tutor integration additive/partial — see
Phase 3 status note), not to this "Phase 2 — Course Builder" section. Flagging the numbering
mismatch here rather than silently renumbering either document.

- Add AI course creation workspace.
- Generate curriculum proposal from goals and source material.
- Generate activities and assessments.
- Map generated content to skills.
- Require human review before publishing.

### Phase 3 — Learner Intelligence

**Status (2026-09-10): partially implemented** — "Rebuild tutor on knowledge-layer retrieval"
(first bullet below) now has both its Knowledge foundation (`src/lib/domain/knowledge/{access,
ingestion,retrieval,chunking,lessonBridge}.ts`, `KnowledgeAccess` schema) AND a shared AI runtime
sitting in front of it (`src/lib/ai/runtime/{types,policy,provider,context,persistence}.ts` — this
is the conversational task's own "Phase 2: Knowledge + Permission-Aware RAG Foundation" and "Phase
3: AI Runtime + AI Context Foundation", folded into this document's pre-existing Phase 3 bullet —
see the Phase 2 status note above for why the numbering differs). `/api/ai/tutor` is refactored
onto the runtime: `AIRequestContext` → policy check → `buildAIContext` → model → V2 persistence,
alongside the still-unchanged legacy `AIChat`/`aiCallsUsed` path. Skill profile/gap experience, AI
learning coach, and broader learning-event emission (remaining bullets) are **not implemented**.
Tool calls, WRITE/EXECUTE actions, and any AI Course Builder UI are **not implemented** — see
`docs/V2_AI_ARCHITECTURE.md`, "AI capability classes".

- Rebuild tutor on knowledge-layer retrieval.
- Add skill profile and skill-gap experience.
- Add AI learning coach and recommendations.
- Emit learning events across learner workflows.

### Phase 4 — Manager/Admin Intelligence

- Team skill coverage.
- Skill-gap reporting.
- Natural-language analytics.
- Knowledge administration.
- AI-assisted operational actions with confirmation.

### Phase 5 — Automation

- Workflow definitions.
- Approval steps.
- Scheduled actions.
- Agent runs with strict tool permissions and audit logs.

## Database rollout rules

1. Never drop a legacy table during the first rollout.
2. Add indexes concurrently where supported and safe for the production environment.
3. Backfill in bounded batches.
4. Make dual-read/dual-write behavior observable.
5. Compare V1/V2 results before switching critical reads.
6. Keep rollback paths until V2 has passed production verification.
