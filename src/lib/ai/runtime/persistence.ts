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
