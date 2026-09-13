import { afterAll, describe, expect, it } from "vitest";
import {
  completeExecution,
  createConversation,
  getConversationForContinuation,
  listConversationsForUser,
  listRecentMessages,
  persistCitations,
  persistMessage,
  readConversationLearnerId,
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

describe("Phase 15 — getConversationForContinuation", () => {
  it("resolves a conversation scoped to {id, tenantId, userId} with a matching surface marker", async () => {
    const { tenant, ctx } = await createTenantUser();
    const conversation = await createConversation(
      { tenantId: tenant.id, userId: ctx.userId },
      { surface: "COPILOT", contextMetadata: { surface: "STUDENT_COPILOT", query: "hi" } }
    );

    const resolved = await getConversationForContinuation(
      { tenantId: tenant.id, userId: ctx.userId },
      conversation.id,
      "STUDENT_COPILOT"
    );

    expect(resolved?.id).toBe(conversation.id);
  });

  it("returns null for a nonexistent id", async () => {
    const { tenant, ctx } = await createTenantUser();
    const resolved = await getConversationForContinuation(
      { tenantId: tenant.id, userId: ctx.userId },
      "does-not-exist",
      "STUDENT_COPILOT"
    );
    expect(resolved).toBeNull();
  });

  it("returns null for another user's conversation, even in the same tenant", async () => {
    const { tenant, ctx: ownerCtx } = await createTenantUser();
    const { ctx: otherCtx } = await createTenantUser();
    const conversation = await createConversation(
      { tenantId: tenant.id, userId: ownerCtx.userId },
      { surface: "COPILOT", contextMetadata: { surface: "STUDENT_COPILOT" } }
    );

    const resolved = await getConversationForContinuation(
      { tenantId: tenant.id, userId: otherCtx.userId },
      conversation.id,
      "STUDENT_COPILOT"
    );
    expect(resolved).toBeNull();
  });

  it("returns null for a cross-tenant conversation id", async () => {
    const { tenant: tenantA, ctx: ctxA } = await createTenantUser();
    const { ctx: ctxB } = await createTenantUser();
    const conversation = await createConversation(
      { tenantId: tenantA.id, userId: ctxA.userId },
      { surface: "COPILOT", contextMetadata: { surface: "STUDENT_COPILOT" } }
    );

    const resolved = await getConversationForContinuation(
      { tenantId: ctxB.tenantId as string, userId: ctxB.userId },
      conversation.id,
      "STUDENT_COPILOT"
    );
    expect(resolved).toBeNull();
  });

  it("returns null when the surface marker doesn't match (surface isolation)", async () => {
    const { tenant, ctx } = await createTenantUser();
    const conversation = await createConversation(
      { tenantId: tenant.id, userId: ctx.userId },
      { surface: "COPILOT", contextMetadata: { surface: "INSTRUCTOR_COPILOT" } }
    );

    const resolved = await getConversationForContinuation(
      { tenantId: tenant.id, userId: ctx.userId },
      conversation.id,
      "STUDENT_COPILOT"
    );
    expect(resolved).toBeNull();
  });

  it("returns null when contextMetadata is missing/malformed — never accidentally authorizes continuation", async () => {
    const { tenant, ctx } = await createTenantUser();
    const conversation = await createConversation(
      { tenantId: tenant.id, userId: ctx.userId },
      { surface: "COPILOT" } // no contextMetadata at all
    );

    const resolved = await getConversationForContinuation(
      { tenantId: tenant.id, userId: ctx.userId },
      conversation.id,
      "STUDENT_COPILOT"
    );
    expect(resolved).toBeNull();
  });
});

describe("Phase 15 — readConversationLearnerId", () => {
  it("reads a string learnerId from contextMetadata", () => {
    expect(readConversationLearnerId({ surface: "INSTRUCTOR_COPILOT", learnerId: "u1" })).toBe(
      "u1"
    );
  });
  it("returns null when absent, null, or malformed", () => {
    expect(readConversationLearnerId({ surface: "INSTRUCTOR_COPILOT" })).toBeNull();
    expect(readConversationLearnerId(null)).toBeNull();
    expect(readConversationLearnerId("not-an-object")).toBeNull();
  });
});

describe("Phase 15 — listRecentMessages", () => {
  it("returns an empty array for a conversation with zero messages", async () => {
    const { tenant, ctx } = await createTenantUser();
    const conversation = await createConversation(
      { tenantId: tenant.id, userId: ctx.userId },
      { surface: "COPILOT" }
    );
    expect(await listRecentMessages(conversation.id, 10)).toEqual([]);
  });

  it("returns messages oldest-first, bounded to the given limit, when more than the limit exist", async () => {
    const { tenant, ctx } = await createTenantUser();
    const conversation = await createConversation(
      { tenantId: tenant.id, userId: ctx.userId },
      { surface: "COPILOT" }
    );
    for (let i = 0; i < 12; i++) {
      await persistMessage(conversation.id, i % 2 === 0 ? "user" : "assistant", `message ${i}`);
    }

    const recent = await listRecentMessages(conversation.id, 10);

    expect(recent).toHaveLength(10);
    // The 12 messages are 0..11 — the latest 10 are messages 2..11, oldest first.
    expect(recent[0].content).toBe("message 2");
    expect(recent[9].content).toBe("message 11");
    // Chronological order confirmed.
    for (let i = 1; i < recent.length; i++) {
      expect(recent[i].createdAt.getTime()).toBeGreaterThanOrEqual(
        recent[i - 1].createdAt.getTime()
      );
    }
  });

  it("returns exactly the limit when message count equals the limit", async () => {
    const { tenant, ctx } = await createTenantUser();
    const conversation = await createConversation(
      { tenantId: tenant.id, userId: ctx.userId },
      { surface: "COPILOT" }
    );
    for (let i = 0; i < 10; i++) {
      await persistMessage(conversation.id, "user", `message ${i}`);
    }
    expect(await listRecentMessages(conversation.id, 10)).toHaveLength(10);
  });

  it("only returns user/assistant roles, never system rows", async () => {
    const { tenant, ctx } = await createTenantUser();
    const conversation = await createConversation(
      { tenantId: tenant.id, userId: ctx.userId },
      { surface: "COPILOT" }
    );
    await persistMessage(conversation.id, "system", "internal note");
    await persistMessage(conversation.id, "user", "hello");

    const recent = await listRecentMessages(conversation.id, 10);
    expect(recent.map((m) => m.role)).toEqual(["user"]);
  });
});

describe("Phase 15 — listConversationsForUser", () => {
  it("returns only the caller's own conversations for the requested surface, most-recent-first", async () => {
    const { tenant, ctx } = await createTenantUser();
    const { ctx: otherCtx } = await createTenantUser();
    await createConversation(
      { tenantId: tenant.id, userId: ctx.userId },
      { surface: "COPILOT", contextMetadata: { surface: "STUDENT_COPILOT", query: "first" } }
    );
    const second = await createConversation(
      { tenantId: tenant.id, userId: ctx.userId },
      { surface: "COPILOT", contextMetadata: { surface: "STUDENT_COPILOT", query: "second" } }
    );
    // Different surface, same user — must not appear.
    await createConversation(
      { tenantId: tenant.id, userId: ctx.userId },
      { surface: "SEARCH", contextMetadata: { surface: "SEARCH" } }
    );
    // Same surface, different user — must not appear.
    await createConversation(
      { tenantId: tenant.id, userId: otherCtx.userId },
      { surface: "COPILOT", contextMetadata: { surface: "STUDENT_COPILOT" } }
    );

    const result = await listConversationsForUser(
      { tenantId: tenant.id, userId: ctx.userId },
      "STUDENT_COPILOT"
    );

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe(second.id);
  });

  it("bounds the list to the given limit", async () => {
    const { tenant, ctx } = await createTenantUser();
    for (let i = 0; i < 5; i++) {
      await createConversation(
        { tenantId: tenant.id, userId: ctx.userId },
        { surface: "COPILOT", contextMetadata: { surface: "STUDENT_COPILOT" } }
      );
    }
    const result = await listConversationsForUser(
      { tenantId: tenant.id, userId: ctx.userId },
      "STUDENT_COPILOT",
      3
    );
    expect(result).toHaveLength(3);
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
