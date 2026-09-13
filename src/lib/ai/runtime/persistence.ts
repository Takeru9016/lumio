import type { AIConversationType, AIExecutionStatus, Prisma } from "@/generated/prisma/client";
import type { KnowledgeContextItem } from "@/lib/ai/runtime/context";
import type { AISurface } from "@/lib/ai/runtime/types";
import { db } from "@/lib/db";

/**
 * V2 AI persistence (AIConversation -> AIMessage -> AISourceCitation /
 * AIExecution -> AIUsageEvent). Deliberately NOT AIToolCall — no tool
 * execution exists yet this phase (docs/V2_MIGRATION_MAP.md, Phase 3), so
 * there is nothing to persist there. Does not touch or replace `AIChat` —
 * see docs/V2_AI_ARCHITECTURE.md, "AI usage" and the tutor route for how the
 * two coexist.
 *
 * Every function here requires a tenant (`tenantId: string`, not
 * `string | null`) — a FREE-plan user with no tenant gets none of this;
 * callers must check before calling in (the tutor route only calls these
 * when `user.tenantId` is set, matching Phase 2's Knowledge-retrieval gate).
 */
export type PersistenceScope = { tenantId: string; userId: string };

/**
 * `AISurface` (runtime-level, 4 values: TUTOR/SEARCH/COURSE_CREATOR/COPILOT)
 * is a different taxonomy than the schema's `AIConversationType` (TUTOR/
 * COURSE_BUILDER/ANALYTICS/COACH/GENERAL — predates this phase, see Phase 1).
 * Rather than rename or extend the schema enum for surfaces that aren't
 * wired to a route yet, this maps the two, falling back to GENERAL for
 * surfaces with no matching schema value. Revisit when SEARCH/COPILOT
 * actually ship a route and need their own persisted type.
 */
export function surfaceToConversationType(surface: AISurface): AIConversationType {
  switch (surface) {
    case "TUTOR":
      return "TUTOR";
    case "COURSE_CREATOR":
      return "COURSE_BUILDER";
    case "SEARCH":
    case "COPILOT":
      return "GENERAL";
  }
}

export async function createConversation(
  scope: PersistenceScope,
  params: {
    surface: AISurface;
    title?: string;
    contextMetadata?: Record<string, unknown>;
  }
) {
  return db.aIConversation.create({
    data: {
      tenantId: scope.tenantId,
      userId: scope.userId,
      type: surfaceToConversationType(params.surface),
      title: params.title,
      contextMetadata: params.contextMetadata as Prisma.InputJsonValue | undefined,
    },
  });
}

export async function persistMessage(
  conversationId: string,
  role: "user" | "assistant" | "system",
  content: string,
  metadata?: Record<string, unknown>
) {
  return db.aIMessage.create({
    data: {
      conversationId,
      role,
      content,
      metadata: metadata as Prisma.InputJsonValue | undefined,
    },
  });
}

/** Persists one AISourceCitation per Knowledge result actually used in a response. */
export async function persistCitations(
  conversationId: string,
  messageId: string,
  knowledge: KnowledgeContextItem[]
) {
  if (knowledge.length === 0) return [];
  return db.$transaction(
    knowledge.map((k) =>
      db.aISourceCitation.create({
        data: {
          conversationId,
          messageId,
          knowledgeChunkId: k.chunkId,
          relevance: k.score,
          metadata: { documentId: k.documentId, sourceId: k.sourceId },
        },
      })
    )
  );
}

export async function startExecution(
  scope: PersistenceScope,
  params: { model: string; provider: string; operation: string; conversationId?: string }
) {
  return db.aIExecution.create({
    data: {
      tenantId: scope.tenantId,
      userId: scope.userId,
      conversationId: params.conversationId,
      model: params.model,
      provider: params.provider,
      operation: params.operation,
      status: "RUNNING",
    },
  });
}

export async function completeExecution(
  executionId: string,
  params: {
    status: AIExecutionStatus;
    latencyMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    error?: string;
  }
) {
  return db.aIExecution.update({
    where: { id: executionId },
    data: {
      status: params.status,
      latencyMs: params.latencyMs,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      error: params.error,
      completedAt: new Date(),
    },
  });
}

/**
 * Phase 15 — which continuity-enabled surface a conversation belongs to.
 * `AIConversationType` (schema) can't distinguish these — SEARCH and every
 * COPILOT variant all map to `GENERAL` (see `surfaceToConversationType`
 * above) — so this marker lives in `contextMetadata.surface` instead, the
 * same "reuse the existing JSON field" pattern Phase 14 used for
 * `KnowledgeDocument.metadata.createdByUserId`. No schema change.
 */
export type ConversationSurfaceMarker = "STUDENT_COPILOT" | "INSTRUCTOR_COPILOT" | "ORG_COPILOT";

function readSurfaceMarker(contextMetadata: unknown): string | null {
  if (contextMetadata && typeof contextMetadata === "object" && !Array.isArray(contextMetadata)) {
    const value = (contextMetadata as Record<string, unknown>).surface;
    if (typeof value === "string") return value;
  }
  return null;
}

/**
 * Resolves a client-supplied `conversationId` for continuation. One lookup
 * scoped to {id, tenantId, userId} — never an unscoped lookup followed by a
 * tenant/user check — then the surface marker is verified in application
 * code (contextMetadata isn't a queryable-enough shape to safely trust a
 * malformed/missing value at the DB layer). Returns null on ANY mismatch
 * (not found, wrong tenant, wrong user, wrong/missing surface marker) — the
 * caller must map every case to the same 404, never distinguishing why.
 */
export async function getConversationForContinuation(
  scope: PersistenceScope,
  conversationId: string,
  surfaceMarker: ConversationSurfaceMarker
) {
  const conversation = await db.aIConversation.findFirst({
    where: { id: conversationId, tenantId: scope.tenantId, userId: scope.userId },
  });
  if (!conversation) return null;
  if (readSurfaceMarker(conversation.contextMetadata) !== surfaceMarker) return null;
  return conversation;
}

/** Reads the `learnerId` a conversation was created with, if any (Instructor/Org Copilot only). */
export function readConversationLearnerId(contextMetadata: unknown): string | null {
  if (contextMetadata && typeof contextMetadata === "object" && !Array.isArray(contextMetadata)) {
    const value = (contextMetadata as Record<string, unknown>).learnerId;
    if (typeof value === "string") return value;
  }
  return null;
}

/**
 * Last N `user`/`assistant` messages, oldest first — the bounded model-input
 * window (Phase 15 contract §8: 10 messages, not a display limit — callers
 * needing the full history for UI display should query AIMessage directly
 * or call this with a larger `limit`). Ordered `createdAt desc, id desc` for
 * the tail fetch (deterministic tiebreak for same-millisecond inserts — cuid
 * `id` isn't chronologically sortable but is stable), then reversed into
 * chronological order.
 */
export async function listRecentMessages(conversationId: string, limit: number) {
  const rows = await db.aIMessage.findMany({
    where: { conversationId, role: { in: ["user", "assistant"] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
  });
  return rows.reverse();
}

/**
 * Bounded, most-recent-first list of a user's own conversations for one
 * continuity-enabled surface. Scoped to {tenantId, userId, surface} via a
 * Prisma JSON-path filter on `contextMetadata.surface` — the same filtering
 * pattern Phase 14's `listManageableKnowledgeDocuments` already established
 * for `metadata.createdByUserId`. Never returns another user's or another
 * surface's conversations.
 */
export async function listConversationsForUser(
  scope: PersistenceScope,
  surfaceMarker: ConversationSurfaceMarker,
  limit = 50
) {
  return db.aIConversation.findMany({
    where: {
      tenantId: scope.tenantId,
      userId: scope.userId,
      contextMetadata: { path: ["surface"], equals: surfaceMarker },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
  });
}

/**
 * Append-only usage ledger row. Does NOT touch `User.aiCallsUsed` — that
 * counter is still the live quota mechanism (src/lib/ai/quota.ts) and is
 * incremented separately by the caller, exactly as before this phase.
 */
export async function recordUsageEvent(
  scope: PersistenceScope,
  params: {
    executionId?: string;
    operation: string;
    provider: string;
    model: string;
    inputTokens?: number;
    outputTokens?: number;
    estimatedCost?: number;
  }
) {
  return db.aIUsageEvent.create({
    data: {
      tenantId: scope.tenantId,
      userId: scope.userId,
      executionId: params.executionId,
      operation: params.operation,
      provider: params.provider,
      model: params.model,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      estimatedCost: params.estimatedCost,
    },
  });
}
