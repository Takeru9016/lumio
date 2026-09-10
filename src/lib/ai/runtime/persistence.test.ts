import { afterAll, describe, expect, it } from "vitest";
import {
  completeExecution,
  createConversation,
  persistCitations,
  persistMessage,
  recordUsageEvent,
  startExecution,
  surfaceToConversationType,
} from "@/lib/ai/runtime/persistence";
import { db } from "@/lib/db";
import {
  createIndexedDocument,
  createTenantUser,
  fakeEmbedding,
} from "@/lib/domain/knowledge/__test__/fixtures";

afterAll(async () => {
  await db.$disconnect();
});

describe("V2 AI persistence", () => {
  it("creates a tenant/user-scoped conversation", async () => {
    const { tenant, ctx } = await createTenantUser();
    const conversation = await createConversation(
      { tenantId: tenant.id, userId: ctx.userId },
      { surface: "TUTOR", contextMetadata: { lessonId: "l1" } }
    );

    expect(conversation.tenantId).toBe(tenant.id);
    expect(conversation.userId).toBe(ctx.userId);
    expect(conversation.type).toBe("TUTOR");
  });

  it("persists messages under a conversation", async () => {
    const { tenant, ctx } = await createTenantUser();
    const conversation = await createConversation(
      { tenantId: tenant.id, userId: ctx.userId },
      { surface: "TUTOR" }
    );

    const userMessage = await persistMessage(conversation.id, "user", "what is a closure?");
    const assistantMessage = await persistMessage(conversation.id, "assistant", "a closure is...");

    const messages = await db.aIMessage.findMany({ where: { conversationId: conversation.id } });
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.role).sort()).toEqual(["assistant", "user"]);
    expect(userMessage.conversationId).toBe(conversation.id);
    expect(assistantMessage.conversationId).toBe(conversation.id);
  });

  it("persists one citation per Knowledge result, linked to the message and chunk", async () => {
    const { tenant, ctx } = await createTenantUser();
    const conversation = await createConversation(
      { tenantId: tenant.id, userId: ctx.userId },
      { surface: "TUTOR" }
    );
    const message = await persistMessage(conversation.id, "assistant", "grounded answer");
    const { document, chunk } = await createIndexedDocument({
      tenantId: tenant.id,
      title: "Doc",
      content: "x",
      embedding: fakeEmbedding(1),
    });

    const citations = await persistCitations(conversation.id, message.id, [
      {
        chunkId: chunk.id,
        documentId: document.id,
        sourceId: document.sourceId,
        content: "x",
        score: 0.9,
        citation: { documentTitle: "Doc", sourceId: document.sourceId },
      },
    ]);

    expect(citations).toHaveLength(1);
    const stored = await db.aISourceCitation.findMany({ where: { messageId: message.id } });
    expect(stored).toHaveLength(1);
    expect(stored[0].conversationId).toBe(conversation.id);
    expect(stored[0].relevance).toBe(0.9);
    expect(stored[0].knowledgeChunkId).toBe(chunk.id);
  });

  it("records an execution and a linked usage event — the correlation chain closes end-to-end", async () => {
    const { tenant, ctx } = await createTenantUser();
    const conversation = await createConversation(
      { tenantId: tenant.id, userId: ctx.userId },
      { surface: "TUTOR" }
    );

    const execution = await startExecution(
      { tenantId: tenant.id, userId: ctx.userId },
      {
        model: "gpt-5.4-mini",
        provider: "openai",
        operation: "tutor.chat",
        conversationId: conversation.id,
      }
    );
    expect(execution.status).toBe("RUNNING");
    expect(execution.conversationId).toBe(conversation.id);

    await completeExecution(execution.id, {
      status: "SUCCEEDED",
      latencyMs: 420,
      inputTokens: 100,
      outputTokens: 50,
    });

    const usageEvent = await recordUsageEvent(
      { tenantId: tenant.id, userId: ctx.userId },
      {
        executionId: execution.id,
        operation: "tutor.chat",
        provider: "openai",
        model: "gpt-5.4-mini",
        inputTokens: 100,
        outputTokens: 50,
      }
    );

    // The full chain: conversation -> execution -> usage event, all
    // resolvable back to the same tenant/user without any extra correlation
    // field (confirms AIExecution.id already serves as the correlation id —
    // docs/V2_AI_ARCHITECTURE.md, "AI observability").
    const finishedExecution = await db.aIExecution.findUniqueOrThrow({
      where: { id: execution.id },
    });
    expect(finishedExecution.status).toBe("SUCCEEDED");
    expect(finishedExecution.latencyMs).toBe(420);
    expect(usageEvent.executionId).toBe(execution.id);
    expect(usageEvent.tenantId).toBe(tenant.id);
    expect(usageEvent.userId).toBe(ctx.userId);

    const linkedExecution = await db.aIExecution.findFirst({
      where: { id: usageEvent.executionId ?? undefined },
      select: { conversationId: true },
    });
    expect(linkedExecution?.conversationId).toBe(conversation.id);
  });
});

describe("surfaceToConversationType", () => {
  it("maps TUTOR to TUTOR", () => expect(surfaceToConversationType("TUTOR")).toBe("TUTOR"));
  it("maps COURSE_CREATOR to the schema's COURSE_BUILDER", () =>
    expect(surfaceToConversationType("COURSE_CREATOR")).toBe("COURSE_BUILDER"));
  it("falls back to GENERAL for surfaces with no dedicated schema value", () => {
    expect(surfaceToConversationType("SEARCH")).toBe("GENERAL");
    expect(surfaceToConversationType("COPILOT")).toBe("GENERAL");
  });
});
