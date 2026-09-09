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

The existing lesson-scoped semantic search is useful as an interim implementation, but V2 retrieval must operate on the knowledge layer. Retrieval must enforce tenant and authorization filters before ranking or returning chunks.

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

1. **AI Course Builder** — turn goals/source material into a proposed curriculum, activities, assessments and skill mappings.
2. **AI Tutor** — grounded learner assistance across the authorized knowledge base, not just the current lesson.
3. **AI Learning Coach** — explain progress, skill gaps and recommended next actions.
4. **AI Analytics** — natural-language questions over governed analytics data with evidence.

Agents and autonomous workflows come after these foundations are stable.
