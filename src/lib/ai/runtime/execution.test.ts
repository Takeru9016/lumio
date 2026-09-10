import { afterAll, describe, expect, it } from "vitest";
import { createExecutionTracker, sanitizeErrorForStorage } from "@/lib/ai/runtime/execution";
import { createConversation, startExecution } from "@/lib/ai/runtime/persistence";
import { db } from "@/lib/db";
import { createTenantUser } from "@/lib/domain/knowledge/__test__/fixtures";

afterAll(async () => {
  await db.$disconnect();
});

async function startTestExecution() {
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
  return { tenant, ctx, conversation, execution };
}

describe("createExecutionTracker — reaches a terminal state", () => {
  it("1. successful invocation transitions the execution to SUCCEEDED", async () => {
    const { execution } = await startTestExecution();
    expect(execution.status).toBe("RUNNING");

    const tracker = createExecutionTracker(execution.id, Date.now());
    await tracker.markSucceeded({ inputTokens: 42, outputTokens: 17 });

    const updated = await db.aIExecution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(updated.status).toBe("SUCCEEDED");
    expect(updated.inputTokens).toBe(42);
    expect(updated.outputTokens).toBe(17);
    expect(updated.completedAt).not.toBeNull();
  });

  it("2. a provider/model failure transitions the execution to FAILED, with the error recorded", async () => {
    const { execution } = await startTestExecution();

    const tracker = createExecutionTracker(execution.id, Date.now());
    await tracker.markFailed(new Error("OpenAI API returned a 500"));

    const updated = await db.aIExecution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(updated.status).toBe("FAILED");
    expect(updated.error).toBe("OpenAI API returned a 500");
    expect(updated.completedAt).not.toBeNull();
  });

  it("3. a stream-level failure (a second, independent call site) also transitions the execution to FAILED", async () => {
    const { execution } = await startTestExecution();

    // Simulates streamText's onError and toUIMessageStream's onError both
    // firing for the same underlying failure — two independent call sites,
    // same tracker instance, exactly as wired in /api/ai/tutor/route.ts.
    const tracker = createExecutionTracker(execution.id, Date.now());
    const streamFailure = new Error("stream aborted mid-response");
    await Promise.all([tracker.markFailed(streamFailure), tracker.markFailed(streamFailure)]);

    const updated = await db.aIExecution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(updated.status).toBe("FAILED");
    expect(updated.error).toBe("stream aborted mid-response");
  });

  it("4. no execution remains RUNNING after a handled failure — including a failure before any stream event", async () => {
    const { execution } = await startTestExecution();

    // Simulates the outer try/catch in the route: a synchronous setup error
    // before streamText/toUIMessageStream ever run.
    const tracker = createExecutionTracker(execution.id, Date.now());
    await tracker.markFailed(new Error("failed to build model messages"));

    const updated = await db.aIExecution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(updated.status).not.toBe("RUNNING");
    expect(["SUCCEEDED", "FAILED"]).toContain(updated.status);
  });

  it("is idempotent: only the first of markFailed/markSucceeded wins, in either order", async () => {
    const { execution: execA } = await startTestExecution();
    const trackerA = createExecutionTracker(execA.id, Date.now());
    await trackerA.markFailed(new Error("first"));
    await trackerA.markSucceeded({ inputTokens: 1, outputTokens: 1 }); // must no-op
    const updatedA = await db.aIExecution.findUniqueOrThrow({ where: { id: execA.id } });
    expect(updatedA.status).toBe("FAILED");
    expect(updatedA.inputTokens).toBeNull();

    const { execution: execB } = await startTestExecution();
    const trackerB = createExecutionTracker(execB.id, Date.now());
    await trackerB.markSucceeded({ inputTokens: 5, outputTokens: 5 });
    await trackerB.markFailed(new Error("too late")); // must no-op
    const updatedB = await db.aIExecution.findUniqueOrThrow({ where: { id: execB.id } });
    expect(updatedB.status).toBe("SUCCEEDED");
    expect(updatedB.error).toBeNull();
  });

  it("5. is a safe no-op when no execution was ever started (existing FREE-plan tutor behavior unchanged)", async () => {
    // Mirrors /api/ai/tutor/route.ts: FREE-plan users (no tenant) never call
    // startExecution, so executionId is undefined and the tracker must do
    // nothing — no throw, no phantom DB row.
    const tracker = createExecutionTracker(undefined, Date.now());
    await expect(tracker.markFailed(new Error("x"))).resolves.toBeUndefined();
    await expect(tracker.markSucceeded({})).resolves.toBeUndefined();
    expect(tracker.finalized).toBe(false);
  });

  it("a persistence failure while marking FAILED is caught, not thrown (never obscures the original error)", async () => {
    // An execution id that was never created — completeExecution's update
    // will fail (Prisma throws "Record to update not found"). markFailed
    // must swallow that, not propagate it.
    const tracker = createExecutionTracker("does-not-exist", Date.now());
    await expect(tracker.markFailed(new Error("original model failure"))).resolves.toBeUndefined();
  });
});

describe("sanitizeErrorForStorage", () => {
  it("uses Error.message for Error instances", () => {
    expect(sanitizeErrorForStorage(new Error("boom"))).toBe("boom");
  });

  it("stringifies non-Error values", () => {
    expect(sanitizeErrorForStorage("plain string error")).toBe("plain string error");
    expect(sanitizeErrorForStorage({ code: "ETIMEDOUT" })).toBe("[object Object]");
  });

  it("truncates long messages so a raw stack trace can't be stored wholesale", () => {
    const long = "x".repeat(2000);
    const result = sanitizeErrorForStorage(new Error(long));
    expect(result.length).toBeLessThanOrEqual(500);
  });
});
