# Lumio V2 Domain Model

## Implementation status (2026-09-10, Phase 4)

Phase 4 (AI Course Creator) required **zero schema changes** — confirmed via `git diff --stat
prisma/schema.prisma` returning empty. The existing `Course`/`Section`/`Lesson`/`Quiz`/
`QuizQuestion`/`CourseSkill`/`Skill` models were sufficient; the AI-generated `CourseProposal` is a
Zod-validated, in-memory/client-state shape (`src/lib/domain/course-creator/schema.ts`), never a
persisted draft table. One deliberate gap: the model's per-lesson `supportsSkillNames` has no
table to persist into (no `LessonSkill`/`AssessmentSkill` model exists) — this stays
proposal-only/deferred rather than motivating a new table (see `docs/V2_AI_ARCHITECTURE.md`, "AI
Course Creator"). `src/lib/domain/course/authorization.ts` (`assertCanCreateCourse`) was extracted
from `POST /api/courses`'s inline instructor-role + plan-limit check so both the human and AI
Course Creator save paths enforce identically — not new authorization logic, a refactor of existing logic.

## Implementation status (2026-09-10, Phase 3)

Phase 3 (AI runtime + AI context foundation) required **zero schema changes** — verified by test
(`src/lib/ai/runtime/persistence.test.ts`, "the correlation chain closes end-to-end"), not assumed:
`AIExecution.id` already serves as the correlation identifier this phase needed, reached via
`AIConversation.id` (conversation → message/citation/execution) and `AIUsageEvent.executionId`
(execution → usage event) — all added in Phase 1. `AIToolCall.executionId`, floated as a
possibility in Phase 1's deferral note, was deliberately NOT added — no tool calls exist yet to
correlate (see `docs/V2_AI_ARCHITECTURE.md`, "Tool registry"). See `docs/V2_AI_ARCHITECTURE.md`,
"AI runtime" for the new `src/lib/ai/runtime/` service layer built on top of this existing schema.

## Implementation status (2026-09-10, Phase 2)

Phase 1 (Foundation) schema is implemented in `prisma/schema.prisma`: Skill, SkillCategory,
JobRole, RoleSkill, UserJobRole, UserSkill, SkillEvidence, CourseSkill, KnowledgeSource,
KnowledgeDocument, KnowledgeChunk, AIConversation, AIMessage, AIToolCall, AISourceCitation,
AIExecution, AIUsageEvent, LearningEvent.

Phase 2 (Knowledge + permission-aware RAG foundation) added, on top of that:

- **`KnowledgeAccess`** model + `KnowledgeAccessScope` enum (TENANT/TEAM/USER) — the minimal
  policy schema this document previously deferred. See "Knowledge ownership and authorization"
  below.
- **`KnowledgeDocument.visibility`** (`KnowledgeVisibility`: TENANT default / RESTRICTED).
- **`KnowledgeDocument.activeVersion`** and **`KnowledgeChunk.version`** — the versioning fields
  described in "Document versioning / re-indexing" below.
- A real service layer under `src/lib/domain/knowledge/`: `access.ts` (authorization),
  `ingestion.ts` (write path), `retrieval.ts` (permission-aware search), `chunking.ts` (pure text
  chunker), `lessonBridge.ts` (Lesson coexistence plan — see docs/V2_AI_ARCHITECTURE.md).
- `/api/ai/tutor` additively calls the new retrieval service alongside the existing
  `searchSimilarLessons` — see "V1/V2 coexistence" below.

**Still not implemented** from this document's original design intent: `OrganizationMembership`,
`Permission`, `RolePermission`, `LearningProgram`, `LearningProgramItem`, `Activity`, `Assessment`,
`AssessmentItem`, `LearningGoal`, `SkillLevel`, `SkillGap`, `KnowledgeCitation` (superseded by
`AISourceCitation`), `AIAgentRun`, `EvidenceEvent`. Those remain design intent below, not code.

## Knowledge ownership and authorization (Phase 2B/2C)

Every Knowledge row (`KnowledgeSource`, `KnowledgeDocument`, `KnowledgeChunk`) carries a direct
`tenantId` — not solely inherited through a parent. Nothing in Postgres enforces that a
`KnowledgeDocument.sourceId` points at a `KnowledgeSource` in the *same* tenant (see
`docs/V2_DATABASE_MIGRATION.md` §8 for why this is a known, accepted class of gap across the whole
schema); every write path in `src/lib/domain/knowledge/ingestion.ts` calls
`assertSameTenant()` (`src/lib/domain/knowledge/access.ts`) to check this in application code
instead, and `retrieval.security.test.ts` proves the rejection.

Per-document readability is a two-layer policy, evaluated by `canReadKnowledgeDocument()` (pure
function, `access.ts`) and reproduced verbatim as inline SQL in `retrieval.ts`:

1. **Tenant boundary** (hard gate): `document.tenantId === ctx.tenantId`, always, first.
2. **Status**: only `READY` documents are retrievable.
3. **Visibility**: `TENANT` (default) — any authenticated tenant member can read it, no
   `KnowledgeAccess` rows needed. `RESTRICTED` — fail-closed; readable only via a matching
   `KnowledgeAccess` row: `TENANT`-scope (opt back in), `TEAM`-scope (user is a `TeamMember` of
   that team), or `USER`-scope (row's `userId` matches).

This is deliberately not a general RBAC/ACL system — no roles, no permission strings, no
inheritance hierarchy, no per-chunk overrides. It answers exactly one question ("can this user
read this document") for exactly the three ownership shapes Phase 2C asked for.

## Document versioning / re-indexing (Phase 2A)

No separate version/snapshot table. `KnowledgeDocument.activeVersion` (default `0`, meaning
"never successfully indexed") names the only chunk version retrieval is allowed to read;
`KnowledgeChunk.version` (default `1`) tags which indexing run a chunk belongs to, with
`@@unique([documentId, version, chunkIndex])` preventing duplicate/corrupt ordering within a run.

`indexDocument()` (`src/lib/domain/knowledge/ingestion.ts`) writes all of a run's chunks at
`version = activeVersion + 1` — invisible to retrieval, since `retrieval.ts`'s SQL filters
`c.version = d.activeVersion` — then flips `activeVersion` in one update only after every chunk
persisted successfully. An interrupted run simply never advances `activeVersion`, so the previous
version keeps serving; nothing can mix. Old-version chunks are not deleted automatically (no
cleanup job exists yet — deferred, see "Deferred work").

## V1/V2 coexistence

`Lesson.embedding`, `AIChat`, `User.aiCallsUsed`, `searchSimilarLessons`
(`src/lib/ai/search.ts`), and the pre-Phase-2 `/api/ai/tutor` behavior are all unchanged and
untouched by any Phase 2 code. `/api/ai/tutor` now additionally calls `searchKnowledge()` for
tenant users, merges its results into the same context string, and falls back silently (try/catch)
if that call fails — the existing lesson-only RAG path runs exactly as before for FREE-plan users
(`user.tenantId === null`) and as an unconditional fallback for everyone else.

## Goal
Move from a primarily `User → Course → Section → Lesson` model toward a capability-aware learning platform while retaining backward compatibility.

## Core domains

### Identity and organization
Existing `User`, `Tenant`, `Team`, `TeamMember`, `Invitation` remain foundational.

Add:

- `OrganizationMembership` — explicit membership when one user can belong to multiple organizations.
- `Permission` — named capability such as `course.publish`, `skill.manage`, `knowledge.read`, `ai.execute`.
- `RolePermission` — maps application roles to permissions.

### Learning
Retain existing Course/Section/Lesson initially. Introduce richer concepts additively:

- `LearningProgram` — top-level learning experience/path.
- `LearningProgramItem` — ordered courses or activities in a program.
- `Activity` — generalized learning unit: video, article, document, quiz, assignment, practice, scenario, simulation, reflection, discussion, AI activity, resource.
- `Assessment` — generalized assessment container.
- `AssessmentItem` — question/task definition.
- `LearningGoal` — intended outcome for a program/course/activity.

Existing `Lesson` becomes a compatibility representation of an Activity until migrated.

### Capability
Add:

- `SkillCategory` — taxonomy grouping.
- `Skill` — atomic capability with name, description and level model.
- `SkillLevel` — optional normalized proficiency level definition.
- `JobRole` — organizational role such as Sales Manager or Backend Engineer.
- `RoleSkill` — required/target skill and proficiency for a role.
- `UserJobRole` — current/target role assignment.
- `UserSkill` — observed or assessed user proficiency.
- `CourseSkill` — skills developed by a course/activity.
- `SkillEvidence` — evidence linking a user to a skill through assessment, project, completion, manager validation or other source.
- `SkillGap` — calculated gap between current proficiency and target proficiency.

### Knowledge
Add:

- `KnowledgeSource` — origin such as course, upload, policy, URL, transcript or integration.
- `KnowledgeDocument` — normalized retrievable document.
- `KnowledgeChunk` — chunked text with metadata and embedding.
- `KnowledgeAccess` — explicit tenant/user/team/role visibility when needed.
- `KnowledgeCitation` — durable source metadata for AI responses.

Do not make the course Lesson embedding the canonical knowledge store.

### AI
Replace the conceptual single `AIChat.messages Json` approach with an extensible runtime:

- `AIConversation` — conversation metadata and scope.
- `AIMessage` — individual message.
- `AIToolCall` — tool invocation and result metadata.
- `AISourceCitation` — sources attached to an AI response.
- `AIExecution` — one AI generation/action execution with status, model, latency and cost metadata.
- `AIUsageEvent` — billable/observable usage event.
- `AIAgentRun` — agent execution lifecycle when agents are introduced.

Existing `AIChat` should be retained temporarily for migration compatibility.

### Analytics and evidence
Add:

- `LearningEvent` — immutable event record for meaningful learner/system activity.
- `EvidenceEvent` — optional normalized evidence signal when a learning event contributes to capability state.

Operational state such as `LessonProgress` remains useful; events capture the historical trail.

## Relationship graph

`Tenant → User/Team → JobRole → RoleSkill → Skill`

`User → UserSkill → SkillEvidence → LearningEvent`

`Course → CourseSkill → Skill`

`LearningProgram → Course/Activity → Assessment → LearningEvent`

`KnowledgeSource → KnowledgeDocument → KnowledgeChunk → AI Citation`

`AIConversation → AIMessage → AIExecution → AIToolCall/Citation`

## Important invariants

- Every tenant-owned entity must be tenant-addressable or inherit tenant scope through a trusted parent.
- A user cannot gain access to a skill, document, course or AI context solely because an ID is known.
- Skill proficiency must have provenance: source, timestamp and confidence where applicable.
- AI-generated content must retain provenance and generation metadata.
- AI writes/executions must be auditable.
- Historical learning events are append-only; corrections should be represented as new events or explicit correction records.

## Migration strategy

1. Add new tables with nullable/backfillable foreign keys.
2. Backfill tenant relationships from existing course/user ownership.
3. Create initial skill taxonomy and role mappings.
4. Map each existing Course to a learning program or maintain a one-to-one compatibility mapping.
5. Map each Lesson to an Activity representation.
6. Import existing AIChat JSON into AIConversation/AIMessage where practical.
7. Re-index lesson/text/video transcripts into KnowledgeChunk.
8. Start emitting LearningEvent for new activity.
9. Move UI/service reads to V2 models incrementally.
10. Deprecate legacy fields only after production validation.
