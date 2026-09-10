# Lumio V2 AI Architecture

## Objective
Create one shared AI runtime that powers tutor, content generation, recommendations, search, analytics and future agents.

## AI runtime (implemented, Phase 3, 2026-09-10)

`src/lib/ai/runtime/` — five files, each independently testable:

| File | Role |
|---|---|
| `types.ts` | `AISurface` (TUTOR/SEARCH/COURSE_CREATOR/COPILOT), `AIAction` (READ/GENERATE/WRITE/EXECUTE), `AIRequestContext` (`{auth, surface, conversationId?, courseId?, lessonId?}`), `AIRuntimeError` (typed by category) |
| `policy.ts` | `isActionAllowed(surface, action)` / `assertActionAllowed(...)` — pure, table-driven, fail-closed for unrecognized surfaces |
| `provider.ts` | `modelFor(surface)` — centralizes OpenAI model selection (was scattered per-route) |
| `context.ts` | `buildAIContext(reqCtx, {query?, topK?})` — builds the bounded `AIContextDTO`, calls `searchKnowledge()` (Phase 2) when policy/tenant/query allow it |
| `persistence.ts` | `createConversation`/`persistMessage`/`persistCitations`/`startExecution`/`completeExecution`/`recordUsageEvent` — the V2 AI table writes |

Actual implemented flow (only TUTOR is wired to a route this phase):

`Clerk auth() → withAiGuards (rate limit + quota + user) → enrollment guard → AIRequestContext →
assertActionAllowed(GENERATE) → buildAIContext() [→ searchKnowledge()] → modelFor() → streamText()
→ onEnd: legacy AIChat + aiCallsUsed (unconditional) → V2 persistence (conversation, messages,
citations, execution, usage event — tenant-gated, best-effort)`

This is a real implementation of the pipeline below, not a 1:1 literal match to every named stage
(no separate "Tool Selection"/"Validation"/"Action Policy" stage exists yet — there are no tools
to select and no WRITE/EXECUTE actions to validate against this phase).

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

### Implementation status (Phase 3, 2026-09-10)

Enforced by `src/lib/ai/runtime/policy.ts`, table-driven and fail-closed:

| Surface | READ | GENERATE | WRITE | EXECUTE |
|---|---|---|---|---|
| TUTOR | allowed | allowed | denied | denied |
| SEARCH | allowed | denied (retrieval only, no generation step) | denied | denied |
| COURSE_CREATOR | allowed | allowed | denied | denied |
| COPILOT | allowed | allowed | denied | denied |
| *(unrecognized surface)* | denied | denied | denied | denied |

**WRITE and EXECUTE are `false` for every surface, unconditionally, for the whole phase** — not
merely unimplemented. The runtime has no code path that gives a model direct Prisma write access,
and no tool-execution loop exists to gate in the first place (see "Tool registry" below — not
built this phase). Only TUTOR is wired to an actual route (`/api/ai/tutor`); SEARCH/COURSE_CREATOR/
COPILOT exist in the policy table so it has real shape to extend into, not because those surfaces
have working endpoints yet.

## Tool registry

**Not implemented (Phase 3).** No tools are registered, no tool-call loop exists, `AIToolCall` has
zero writes from the runtime this phase (see "AI persistence" below). This is intentional per
docs/V2_MIGRATION_MAP.md, Phase 3 — WRITE/EXECUTE stay disabled until a tool registry exists to
gate them.

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

## AI persistence

### Implementation status (Phase 3, 2026-09-10)

`/api/ai/tutor` now writes, for tenant users only (V2 tables require `tenantId`; a FREE-plan user
has none — see "AI usage" below for the exact same gate applied to the ledger):

`AIConversation` (one per request this phase — not resumed/continued across requests; see
"Deferred" in the Phase 3 report) → `AIMessage` (user query + assistant response) →
`AISourceCitation` (one per Knowledge result actually used) → `AIExecution` (RUNNING → SUCCEEDED/
FAILED, with latency and token counts when available) → `AIUsageEvent` (linked via `executionId`).

`AIToolCall` is not written — no tool calls exist this phase (see "Tool registry" above).

**Legacy `AIChat` compatibility**: unconditional and unchanged. `persistChat()` (the pre-Phase-3
function) still runs on every request, before any V2 write, exactly as before. V2 persistence is
strictly additive: if it fails, it's logged and the request has already succeeded — see "Error
handling" below.

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

### Implementation status (Phase 3, 2026-09-10)

`recordUsageEvent()` (`src/lib/ai/runtime/persistence.ts`) writes tenantId, userId, executionId,
operation, provider, model, and input/output token counts (when the AI SDK's `result.usage`
resolves — best-effort, not guaranteed). Estimated cost is not computed (no pricing table exists
yet — deferred, not invented speculatively). **`User.aiCallsUsed` is unchanged and remains the
live quota-check mechanism** (`src/lib/ai/quota.ts`, `withAiGuards`) — `AIUsageEvent` is written
alongside it, not derived from or feeding into it yet.

## Error handling (Phase 3, 2026-09-10)

The runtime distinguishes these failure categories (`AIRuntimeError.category`,
`src/lib/ai/runtime/types.ts`) and treats each differently — this is a deliberate decision, not a
uniform catch-all:

| Category | Behavior |
|---|---|
| Auth failure (no session) | Request fails before any model call — unchanged, handled by `withAiGuards` (401) exactly as before this phase. |
| AI policy denial | Request fails before any model call (`assertActionAllowed` throws `AIRuntimeError("POLICY_DENIED")`). For TUTOR/GENERATE this never actually fires today — the check exists so a future WRITE/EXECUTE attempt fails loudly, not silently. |
| Quota/rate-limit failure | Unchanged — `withAiGuards` (429/403), before any model call. |
| Knowledge retrieval failure | **Logged (`console.error`), not thrown.** `buildAIContext` degrades to an empty knowledge array; the tutor still has lesson-scoped context as a fallback. This is a considered choice, not an oversight: now that the runtime is the retrieval path, silent-with-no-log would hide real breakage — Phase 2's original bare `catch {}` was upgraded to a logged catch for this reason. |
| Provider/model failure | Not specially handled by the runtime — an AI SDK stream error propagates to the client via the existing `toUIMessageStream` error surface, same as before this phase. An `AIExecution` left in `RUNNING` status is a known, accepted gap this phase (see "Deferred" in the Phase 3 report) — it is not marked `FAILED` automatically. |
| Persistence/usage-event failure (after a successful model response) | **Logged, response still succeeds.** The user has already received their answer by the time V2 persistence runs in `onEnd`; failing the response retroactively over a bookkeeping error would be worse than losing one usage-event row. Legacy `AIChat`/`aiCallsUsed` persistence is unconditional and separate from this — it is not subject to this fallback. |

No security failure (auth, policy, quota) is ever silently swallowed — every one of those either
throws before reaching the model or short-circuits the route with an error response. Only
non-critical observability paths (Knowledge retrieval quality, V2 bookkeeping) degrade silently
to the *user*, and even those are logged server-side.

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
2. **AI Tutor** — grounded learner assistance across the authorized knowledge base, not just the current lesson. Partially started: `/api/ai/tutor` is now refactored onto the shared runtime (Phase 3 — policy check, `buildAIContext`, V2 persistence) on top of Phase 2G's additive `searchKnowledge()` call. Still lesson-scoped by trigger condition (`lessonId` required), not yet a standalone "ask anything the tenant has indexed" experience.
3. **AI Learning Coach** — explain progress, skill gaps and recommended next actions. Not started.
4. **AI Analytics** — natural-language questions over governed analytics data with evidence. Not started.

Agents and autonomous workflows come after these foundations are stable.
