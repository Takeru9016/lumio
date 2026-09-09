# Lumio V2 Architecture

## Status
Proposed architecture baseline for the AI-native LMS / Learning & Capability Platform.

## Product thesis
Lumio should evolve from a course-centric LMS into an AI-native learning and capability platform that connects:

`People → Roles → Skills → Knowledge → Learning → Evidence → Outcomes`

AI is an intelligence and action layer across those systems, not a standalone chatbot.

## Architectural principles

1. **Tenant isolation is mandatory.** Every tenant-owned read/write operation must resolve and enforce tenant scope before business logic.
2. **Capabilities are first-class.** Skills, roles, evidence and gaps are product primitives, not reporting metadata.
3. **Knowledge is separate from courses.** Documents, transcripts, policies and learning content can all become retrievable knowledge sources.
4. **AI is a shared runtime.** Tutor, generation, recommendations, analytics and agents use common context, retrieval, tools, policy and observability layers.
5. **AI actions are permissioned.** Reading, generating, writing and executing are distinct capability levels.
6. **Events are the source for behavioral analytics.** Progress tables remain operational state; learning events capture history and causality.
7. **Migration is additive.** Existing Course → Section → Lesson data remains valid while V2 entities are introduced and backfilled.
8. **Human review remains explicit.** AI-generated learning assets must have provenance and review/publish states.

## System boundaries

### Learning
Courses, modules, lessons, activities, assessments, paths, enrollments, progress and certifications.

### Capability
Skills, skill categories, roles, role requirements, user skill profiles, evidence and skill gaps.

### Knowledge
Knowledge sources, documents, chunks, embeddings, metadata, permissions and citations.

### Intelligence
AI runtime, model routing, retrieval, tutor, copilot, recommendations, natural-language analytics and agents.

### Action
Workflows, approvals, notifications, integrations and audited AI actions.

## Target request flow

`UI → Route/Server Action → Auth Context → Tenant Scope → Domain Service → AI/Knowledge/Workflow Service → Persistence → Event`

AI requests additionally follow:

`AI UI → AI Runtime → Context Builder → Permissioned Retrieval → Tool Registry → Model → Structured Output → Policy Check → Persist/Audit → Event`

## Proposed service boundaries

- `src/lib/auth/` — identity, tenant context, role and permission resolution.
- `src/lib/domain/learning/` — courses, activities, enrollments, progress.
- `src/lib/domain/capability/` — skills, roles, evidence and gaps.
- `src/lib/domain/knowledge/` — sources, documents, chunks, embeddings and retrieval.
- `src/lib/ai/runtime/` — model execution, context, policies, tools, citations and usage.
- `src/lib/analytics/` — event ingestion and read models.
- `src/lib/workflows/` — workflow definitions, execution and approvals.

## API direction

Keep existing routes for compatibility, but add domain-oriented endpoints as new workflows are built. Avoid one-off AI routes that each implement authentication, quota, retrieval and persistence differently.

## First vertical

Build the first end-to-end V2 vertical as **AI Course Creation → AI Learning → Skill Evidence**. This validates the new domain model without requiring a full rewrite.

## Migration rule

Do not delete or rename existing core models in the first migration wave. Introduce V2 models, backfill relationships, migrate read/write paths incrementally, then deprecate old fields only after production verification.
