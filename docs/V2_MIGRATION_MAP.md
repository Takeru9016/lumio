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

- `src/lib/ai/search.ts` → knowledge retrieval service with authorization-aware filters.
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

- Add Skill, SkillCategory, JobRole, RoleSkill, UserSkill, UserJobRole, SkillEvidence and SkillGap.
- Add KnowledgeSource, KnowledgeDocument and KnowledgeChunk.
- Add AIExecution, AIMessage, AIToolCall, AISourceCitation and AIUsageEvent.
- Add LearningEvent.
- Add tenant-aware authorization helpers.

### Phase 2 — Course Builder

- Add AI course creation workspace.
- Generate curriculum proposal from goals and source material.
- Generate activities and assessments.
- Map generated content to skills.
- Require human review before publishing.

### Phase 3 — Learner Intelligence

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
