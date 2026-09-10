# Lumio V2 AI Architecture

## Objective
Create one shared AI runtime that powers tutor, content generation, recommendations, search, analytics and future agents.

## Runtime pipeline

`Request → Auth → Tenant Scope → AI Policy → Context Builder → Permissioned Retrieval → Tool Selection → Model → Structured Output → Validation → Action Policy → Persistence → Audit/Event`

## Context builder

AI context should be assembled from explicit scopes rather than arbitrary database queries:

- actor: user, role, tenant, team
- task: tutor, authoring, analytics, recommendation, admin
- learning context: course/program/activity/progress
- capability context: roles, skills, gaps, evidence
- knowledge context: permitted documents/chunks
- conversation context: recent messages and durable summary
- tool context: only tools the actor can use

## Retrieval

### Implementation status (Phase 2, 2026-09-10)

`searchKnowledge()` (`src/lib/domain/knowledge/retrieval.ts`) is the V2 retrieval implementation.
It takes a required `KnowledgeAccessContext` (never a bare tenant id) and inlines every
authorization clause — tenant match, `status = 'READY'`, visibility/`KnowledgeAccess` check,
active-version match — directly into the `WHERE` of the one query that also ranks and limits
results (pgvector `<=>` cosine distance, deterministic tie-break by `chunk.id`). No candidate
chunk is ever fetched, ranked, or logged before Postgres itself has evaluated the authorization
predicate — this is the specific difference from the interim `searchSimilarLessons`
(`src/lib/ai/search.ts`), which has no tenant filter at all (`Lesson` has no `tenantId`) and
relies entirely on an optional, caller-supplied `courseId`. `searchSimilarLessons` is unchanged
and still runs as-is; `searchKnowledge` does not replace it this phase (see "Lesson bridge" in
`docs/V2_MIGRATION_MAP.md`).

Required retrieval metadata (below) — current coverage: tenantId, sourceId/documentId/chunkId,
and embedding model (stored as `{embeddingModel, embeddingProvider}` in `KnowledgeChunk.metadata`
— a JSON blob, not dedicated columns; flagged as a real but non-blocking gap versus "typed and
queryable" in the Phase 1 audit) are populated. Visibility/access scope is enforced but not
returned in results. Course/program/activity identifiers are not yet wired (no `LearningProgram`
exists). Every result carries a `citation: { documentTitle, sourceId }`.

Required retrieval metadata:

- tenantId
- sourceId/documentId/chunkId
- source type
- visibility/access scope
- course/program/activity identifiers when applicable
- created/updated timestamps
- embedding model/version

Every grounded answer should be able to produce durable source citations.

## AI capability classes

### READ
Search knowledge, inspect progress, inspect skills, query analytics.

### GENERATE
Create drafts, summaries, questions, learning paths, feedback or recommendations.

### WRITE
Modify a course, skill mapping, assignment feedback, enrollment or other persistent state.

### EXECUTE
Perform consequential operations such as publishing, assigning training, changing permissions or triggering integrations.

READ/GENERATE can generally be automatic within permissions. WRITE should require an explicit user action for consequential changes. EXECUTE requires permission plus confirmation unless an approved workflow explicitly authorizes it.

## Tool registry

Tools should be centrally defined with:

- tool name and description
- input schema
- required permission
- tenant scope requirement
- confirmation requirement
- audit event type
- timeout/retry policy

Avoid embedding database mutations directly inside prompt handlers.

## Model routing

Introduce a model policy layer instead of hard-coding a model per route. Route by task complexity, latency, cost and required output quality. Record provider/model/version for every execution.

## Structured output

Prefer schema-validated structured output for generated artifacts. A generation response should carry:

- execution id
- artifact type
- content
- provenance
- confidence/quality metadata where appropriate
- source citations
- model metadata

## AI usage

The current `User.aiCallsUsed` counter is sufficient for the existing MVP but should not remain the billing/observability source of truth. V2 should record immutable `AIUsageEvent` rows and derive quota/reporting from them or from a materialized usage ledger.

Track at minimum:

- tenantId/userId
- feature
- provider/model
- input/output token counts when available
- estimated cost
- execution status
- latency
- timestamp

## AI safety and trust UX

AI UI must make the following visible where relevant:

- AI-generated state
- sources/citations
- what data was used
- whether output is a draft or committed change
- approval/confirmation state
- ability to inspect or undo consequential actions

## First AI workflows

1. **AI Course Builder** — turn goals/source material into a proposed curriculum, activities, assessments and skill mappings. Not started.
2. **AI Tutor** — grounded learner assistance across the authorized knowledge base, not just the current lesson. Partially started: `/api/ai/tutor` additively calls `searchKnowledge()` alongside the existing lesson search (Phase 2G) — still lesson-scoped by trigger condition (`lessonId` required), not yet a standalone "ask anything the tenant has indexed" experience.
3. **AI Learning Coach** — explain progress, skill gaps and recommended next actions. Not started.
4. **AI Analytics** — natural-language questions over governed analytics data with evidence. Not started.

Agents and autonomous workflows come after these foundations are stable.
