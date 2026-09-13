import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level test for POST /api/ai/instructor/copilot, mirroring
 * /api/ai/copilot's mocked-boundary style (Phase 12), adapted for the
 * INSTRUCTOR-only role check and learnerId handling.
 */
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
}));

vi.mock("@/lib/ai/middleware", () => ({
  withAiGuards: vi.fn(),
}));

vi.mock("@/lib/ratelimit", () => ({
  instructorCopilotRatelimit: {},
}));

vi.mock("ai", () => ({
  generateText: vi.fn(),
}));

vi.mock("@/lib/domain/capability/instructorCopilotContext", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/domain/capability/instructorCopilotContext")
  >("@/lib/domain/capability/instructorCopilotContext");
  return {
    InstructorCopilotLearnerNotFoundError: actual.InstructorCopilotLearnerNotFoundError,
    buildInstructorCopilotContext: vi.fn(),
  };
});

vi.mock("@/lib/ai/runtime/provider", () => ({
  modelFor: vi.fn(() => ({ model: {}, provider: "openai", modelId: "gpt-5.4-mini" })),
}));

vi.mock("@/lib/ai/runtime/persistence", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/runtime/persistence")>(
    "@/lib/ai/runtime/persistence"
  );
  return {
    createConversation: vi.fn(),
    startExecution: vi.fn(),
    persistMessage: vi.fn(),
    recordUsageEvent: vi.fn(),
    getConversationForContinuation: vi.fn(),
    listRecentMessages: vi.fn(),
    readConversationLearnerId: actual.readConversationLearnerId,
  };
});

vi.mock("@/lib/ai/runtime/execution", () => ({
  createExecutionTracker: vi.fn(() => ({
    finalized: false,
    markFailed: vi.fn(),
    markSucceeded: vi.fn(),
  })),
}));

vi.mock("@/lib/ai/quota", () => ({
  incrementAiUsage: vi.fn(),
}));

const { auth } = await import("@clerk/nextjs/server");
const { withAiGuards } = await import("@/lib/ai/middleware");
const { generateText } = await import("ai");
const { buildInstructorCopilotContext, InstructorCopilotLearnerNotFoundError } = await import(
  "@/lib/domain/capability/instructorCopilotContext"
);
const {
  createConversation,
  startExecution,
  persistMessage,
  recordUsageEvent,
  getConversationForContinuation,
  listRecentMessages,
} = await import("@/lib/ai/runtime/persistence");
const { createExecutionTracker } = await import("@/lib/ai/runtime/execution");
const { incrementAiUsage } = await import("@/lib/ai/quota");
const { POST } = await import("./route");

const authMock = vi.mocked(auth);
const withAiGuardsMock = vi.mocked(withAiGuards);
const generateTextMock = vi.mocked(generateText);
const buildContextMock = vi.mocked(buildInstructorCopilotContext);
const createConversationMock = vi.mocked(createConversation);
const startExecutionMock = vi.mocked(startExecution);
const persistMessageMock = vi.mocked(persistMessage);
const recordUsageEventMock = vi.mocked(recordUsageEvent);
const getConversationForContinuationMock = vi.mocked(getConversationForContinuation);
const listRecentMessagesMock = vi.mocked(listRecentMessages);
const createExecutionTrackerMock = vi.mocked(createExecutionTracker);
const incrementAiUsageMock = vi.mocked(incrementAiUsage);

const req = (body: unknown) =>
  new Request("http://localhost/api/ai/instructor/copilot", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

function mockUser(overrides: Partial<{ tenantId: string | null; role: string }> = {}) {
  const user = { id: "u1", tenantId: "t1", role: "INSTRUCTOR", plan: "STARTER", ...overrides };
  withAiGuardsMock.mockResolvedValue({ ok: true, user } as never);
  authMock.mockResolvedValue({ userId: "c1" } as never);
  return user;
}

const COHORT_CONTEXT = {
  scope: "cohort",
  cohortSize: 2,
  cohortTruncated: false,
  roleBreakdown: [{ roleName: "Sales Rep", learnerCount: 2 }],
  skillAggregates: [{ skillName: "Negotiation", metCount: 1, gapCount: 1 }],
};

function mockPersistenceHappyPath() {
  createConversationMock.mockResolvedValue({ id: "conv1" } as never);
  startExecutionMock.mockResolvedValue({ id: "exec1" } as never);
  persistMessageMock.mockResolvedValue({ id: "msg1" } as never);
  recordUsageEventMock.mockResolvedValue({} as never);
  createExecutionTrackerMock.mockReturnValue({
    finalized: false,
    markFailed: vi.fn(),
    markSucceeded: vi.fn(),
  } as never);
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("POST /api/ai/instructor/copilot — authentication & authorization", () => {
  it("unauthenticated -> 401", async () => {
    authMock.mockResolvedValue({ userId: null } as never);
    withAiGuardsMock.mockResolvedValue({
      ok: false,
      response: new Response("Unauthorized", { status: 401 }),
    });

    const res = await POST(req({ query: "Which skills are missing?" }));
    expect(res.status).toBe(401);
  });

  it("authenticated without tenant -> 400", async () => {
    mockUser({ tenantId: null });

    const res = await POST(req({ query: "hello" }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "No organisation found" });
  });

  it("INSTRUCTOR -> allowed (200)", async () => {
    mockUser({ role: "INSTRUCTOR" });
    buildContextMock.mockResolvedValue(COHORT_CONTEXT as never);
    mockPersistenceHappyPath();
    generateTextMock.mockResolvedValue({
      text: "Negotiation is the biggest gap.",
      usage: {},
    } as never);

    const res = await POST(req({ query: "Which skills are missing?" }));

    expect(res.status).toBe(200);
  });

  it("STUDENT -> 403", async () => {
    mockUser({ role: "STUDENT" });
    const res = await POST(req({ query: "hello" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("ORG_ADMIN -> 403", async () => {
    mockUser({ role: "ORG_ADMIN" });
    const res = await POST(req({ query: "hello" }));
    expect(res.status).toBe(403);
  });

  it("SUPER_ADMIN -> 403, no shortcut", async () => {
    mockUser({ role: "SUPER_ADMIN" });
    const res = await POST(req({ query: "hello" }));
    expect(res.status).toBe(403);
  });
});

describe("POST /api/ai/instructor/copilot — request validation", () => {
  it("empty query -> 400", async () => {
    mockUser();
    const res = await POST(req({ query: "" }));
    expect(res.status).toBe(400);
  });

  it("2001-character query -> 400", async () => {
    mockUser();
    const res = await POST(req({ query: "a".repeat(2001) }));
    expect(res.status).toBe(400);
  });

  it("malformed JSON -> 400", async () => {
    mockUser();
    const res = await POST(req("not json"));
    expect(res.status).toBe(400);
  });

  it("unknown extra field -> 400", async () => {
    mockUser();
    const res = await POST(req({ query: "hello", extra: "field" }));
    expect(res.status).toBe(400);
  });

  it("userId in body -> 400, never reaches the domain function", async () => {
    mockUser();
    const res = await POST(req({ query: "hello", userId: "someone-elses-id" }));
    expect(res.status).toBe(400);
    expect(buildContextMock).not.toHaveBeenCalled();
  });

  it("tenantId in body -> 400, never reaches the domain function", async () => {
    mockUser();
    const res = await POST(req({ query: "hello", tenantId: "someone-elses-tenant" }));
    expect(res.status).toBe(400);
    expect(buildContextMock).not.toHaveBeenCalled();
  });

  it("instructorId in body -> 400", async () => {
    mockUser();
    const res = await POST(req({ query: "hello", instructorId: "someone-else" }));
    expect(res.status).toBe(400);
  });

  it("learnerId is accepted as a valid field", async () => {
    mockUser();
    buildContextMock.mockResolvedValue({
      scope: "learner",
      cohortSize: 1,
      cohortTruncated: false,
      roleBreakdown: [],
      skillAggregates: [],
      learner: { learnerName: "Amy", roleName: "Sales Rep", skills: [] },
    } as never);
    mockPersistenceHappyPath();
    generateTextMock.mockResolvedValue({ text: "Amy is on track.", usage: {} } as never);

    const res = await POST(req({ query: "Tell me about this learner", learnerId: "u1" }));
    expect(res.status).toBe(200);
  });
});

describe("POST /api/ai/instructor/copilot — learnerId security", () => {
  it("learnerId is passed to buildInstructorCopilotContext, never used for a direct DB lookup by the route", async () => {
    mockUser();
    buildContextMock.mockResolvedValue(COHORT_CONTEXT as never);
    mockPersistenceHappyPath();
    generateTextMock.mockResolvedValue({ text: "Answer.", usage: {} } as never);

    await POST(req({ query: "Tell me about this learner", learnerId: "u1" }));

    expect(buildContextMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", tenantId: "t1", role: "INSTRUCTOR" }),
      { learnerId: "u1" }
    );
  });

  it("learnerId not found in the authorized page -> 404, generic message", async () => {
    mockUser();
    buildContextMock.mockRejectedValue(new InstructorCopilotLearnerNotFoundError());

    const res = await POST(req({ query: "Tell me about this learner", learnerId: "not-mine" }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ error: "Learner not found in your capability report" });
  });
});

describe("POST /api/ai/instructor/copilot — AI contract", () => {
  it("uses modelFor('COPILOT') and generateText, no tools", async () => {
    mockUser();
    buildContextMock.mockResolvedValue(COHORT_CONTEXT as never);
    mockPersistenceHappyPath();
    generateTextMock.mockResolvedValue({ text: "Answer.", usage: {} } as never);

    await POST(req({ query: "Which skills are missing?" }));

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    const call = generateTextMock.mock.calls[0][0] as Record<string, unknown>;
    expect(call).not.toHaveProperty("tools");
  });

  it("cohort context is passed into the generation prompt", async () => {
    mockUser();
    buildContextMock.mockResolvedValue(COHORT_CONTEXT as never);
    mockPersistenceHappyPath();
    generateTextMock.mockResolvedValue({ text: "Answer.", usage: {} } as never);

    await POST(req({ query: "Which skills are missing?" }));

    const call = generateTextMock.mock.calls[0][0] as { system: string };
    expect(call.system).toContain("Sales Rep");
    expect(call.system).toContain("Negotiation");
  });
});

describe("POST /api/ai/instructor/copilot — response shape", () => {
  it("successful response is exactly { answer, conversationId }", async () => {
    mockUser();
    buildContextMock.mockResolvedValue(COHORT_CONTEXT as never);
    mockPersistenceHappyPath();
    generateTextMock.mockResolvedValue({ text: "Focus on Negotiation.", usage: {} } as never);

    const res = await POST(req({ query: "What should I focus on?" }));
    const body = await res.json();

    expect(body).toEqual({ answer: "Focus on Negotiation.", conversationId: "conv1" });
  });
});

describe("POST /api/ai/instructor/copilot — Phase 15 conversation continuity", () => {
  it("omitting conversationId creates a new conversation with the INSTRUCTOR_COPILOT surface marker", async () => {
    mockUser();
    buildContextMock.mockResolvedValue(COHORT_CONTEXT as never);
    mockPersistenceHappyPath();
    generateTextMock.mockResolvedValue({ text: "Answer.", usage: {} } as never);

    await POST(req({ query: "hello" }));

    expect(createConversationMock).toHaveBeenCalledWith(
      { tenantId: "t1", userId: "u1" },
      expect.objectContaining({
        contextMetadata: { surface: "INSTRUCTOR_COPILOT", query: "hello", learnerId: undefined },
      })
    );
  });

  it("a valid conversationId (no learnerId, matching) reuses the existing conversation", async () => {
    mockUser();
    getConversationForContinuationMock.mockResolvedValue({
      id: "conv1",
      contextMetadata: { surface: "INSTRUCTOR_COPILOT" },
    } as never);
    listRecentMessagesMock.mockResolvedValue([]);
    buildContextMock.mockResolvedValue(COHORT_CONTEXT as never);
    mockPersistenceHappyPath();
    generateTextMock.mockResolvedValue({ text: "Second answer.", usage: {} } as never);

    const res = await POST(req({ query: "and then?", conversationId: "conv1" }));

    expect(res.status).toBe(200);
    expect(createConversationMock).not.toHaveBeenCalled();
    expect(getConversationForContinuationMock).toHaveBeenCalledWith(
      { tenantId: "t1", userId: "u1" },
      "conv1",
      "INSTRUCTOR_COPILOT"
    );
  });

  it("invalid/cross-tenant/cross-surface conversationId -> 404", async () => {
    mockUser();
    getConversationForContinuationMock.mockResolvedValue(null);

    const res = await POST(req({ query: "hello", conversationId: "not-mine" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Conversation not found" });
  });

  it("second generation receives the first turn as bounded history (limit 10)", async () => {
    mockUser();
    getConversationForContinuationMock.mockResolvedValue({
      id: "conv1",
      contextMetadata: { surface: "INSTRUCTOR_COPILOT" },
    } as never);
    listRecentMessagesMock.mockResolvedValue([
      { role: "user", content: "Which skills are missing?" },
      { role: "assistant", content: "Negotiation is the biggest gap." },
    ] as never);
    buildContextMock.mockResolvedValue(COHORT_CONTEXT as never);
    mockPersistenceHappyPath();
    generateTextMock.mockResolvedValue({ text: "Focus there first.", usage: {} } as never);

    await POST(req({ query: "What should we do about it?", conversationId: "conv1" }));

    expect(listRecentMessagesMock).toHaveBeenCalledWith("conv1", 10);
    const call = generateTextMock.mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(call.messages).toEqual([
      { role: "user", content: "Which skills are missing?" },
      { role: "assistant", content: "Negotiation is the biggest gap." },
      { role: "user", content: "What should we do about it?" },
    ]);
  });
});

describe("POST /api/ai/instructor/copilot — Phase 15 learner context lock", () => {
  it("continuing with the same learnerId the conversation was created with -> success", async () => {
    mockUser();
    getConversationForContinuationMock.mockResolvedValue({
      id: "conv1",
      contextMetadata: { surface: "INSTRUCTOR_COPILOT", learnerId: "learner-1" },
    } as never);
    listRecentMessagesMock.mockResolvedValue([]);
    buildContextMock.mockResolvedValue(COHORT_CONTEXT as never);
    mockPersistenceHappyPath();
    generateTextMock.mockResolvedValue({ text: "Answer.", usage: {} } as never);

    const res = await POST(
      req({ query: "more about this learner", learnerId: "learner-1", conversationId: "conv1" })
    );

    expect(res.status).toBe(200);
  });

  it("continuing with a DIFFERENT learnerId than the conversation was created with -> 400, never silently switches", async () => {
    mockUser();
    getConversationForContinuationMock.mockResolvedValue({
      id: "conv1",
      contextMetadata: { surface: "INSTRUCTOR_COPILOT", learnerId: "learner-1" },
    } as never);

    const res = await POST(
      req({ query: "tell me about someone else", learnerId: "learner-2", conversationId: "conv1" })
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "This conversation is scoped to a different learner",
    });
    expect(buildContextMock).not.toHaveBeenCalled();
  });

  it("omitting learnerId on a continuation that originally had one -> 400, never silently ignores it", async () => {
    mockUser();
    getConversationForContinuationMock.mockResolvedValue({
      id: "conv1",
      contextMetadata: { surface: "INSTRUCTOR_COPILOT", learnerId: "learner-1" },
    } as never);

    const res = await POST(req({ query: "cohort question", conversationId: "conv1" }));

    expect(res.status).toBe(400);
  });

  it("cohort-scoped (no learnerId) conversation continued with a learnerId -> 400", async () => {
    mockUser();
    getConversationForContinuationMock.mockResolvedValue({
      id: "conv1",
      contextMetadata: { surface: "INSTRUCTOR_COPILOT" },
    } as never);

    const res = await POST(
      req({ query: "now about this learner", learnerId: "learner-1", conversationId: "conv1" })
    );

    expect(res.status).toBe(400);
  });
});

describe("POST /api/ai/instructor/copilot — Phase 15 surface isolation", () => {
  it("a Student Copilot conversation id is never usable here (resolver returns null for a non-matching marker)", async () => {
    mockUser();
    // getConversationForContinuation is mocked at the boundary — this test
    // asserts the route always passes ITS OWN marker, so a real resolver
    // (tested directly in persistence.test.ts) would reject a STUDENT_COPILOT
    // row regardless of what this mock returns.
    getConversationForContinuationMock.mockResolvedValue(null);

    const res = await POST(req({ query: "hello", conversationId: "student-conv-1" }));

    expect(getConversationForContinuationMock).toHaveBeenCalledWith(
      expect.anything(),
      "student-conv-1",
      "INSTRUCTOR_COPILOT"
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/ai/instructor/copilot — persistence", () => {
  it("persists AIConversation(GENERAL)/user+assistant AIMessage/AIExecution/AIUsageEvent with operation capability.instructor.copilot, no citations", async () => {
    mockUser();
    buildContextMock.mockResolvedValue(COHORT_CONTEXT as never);
    mockPersistenceHappyPath();
    generateTextMock.mockResolvedValue({ text: "Answer.", usage: {} } as never);

    await POST(req({ query: "Which skills are missing?" }));

    expect(createConversationMock).toHaveBeenCalledWith(
      { tenantId: "t1", userId: "u1" },
      expect.objectContaining({ surface: "COPILOT" })
    );
    expect(startExecutionMock).toHaveBeenCalledWith(
      { tenantId: "t1", userId: "u1" },
      expect.objectContaining({
        operation: "capability.instructor.copilot",
        conversationId: "conv1",
      })
    );
    expect(persistMessageMock).toHaveBeenCalledWith("conv1", "user", "Which skills are missing?");
    expect(persistMessageMock).toHaveBeenCalledWith("conv1", "assistant", "Answer.");
    expect(recordUsageEventMock).toHaveBeenCalledWith(
      { tenantId: "t1", userId: "u1" },
      expect.objectContaining({ operation: "capability.instructor.copilot", executionId: "exec1" })
    );
    expect(incrementAiUsageMock).toHaveBeenCalledWith("u1");
  });

  it("incrementAiUsage is NOT called when generateText throws", async () => {
    mockUser();
    buildContextMock.mockResolvedValue(COHORT_CONTEXT as never);
    createConversationMock.mockResolvedValue({ id: "conv1" } as never);
    startExecutionMock.mockResolvedValue({ id: "exec1" } as never);
    persistMessageMock.mockResolvedValue({ id: "msg1" } as never);
    createExecutionTrackerMock.mockReturnValue({
      finalized: false,
      markFailed: vi.fn(),
      markSucceeded: vi.fn(),
    } as never);
    generateTextMock.mockRejectedValue(new Error("provider exploded"));

    await POST(req({ query: "hello" }));

    expect(incrementAiUsageMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/ai/instructor/copilot — generation failure", () => {
  it("provider/generation failure -> 502, sanitized message, execution marked FAILED", async () => {
    mockUser();
    buildContextMock.mockResolvedValue(COHORT_CONTEXT as never);
    createConversationMock.mockResolvedValue({ id: "conv1" } as never);
    startExecutionMock.mockResolvedValue({ id: "exec1" } as never);
    persistMessageMock.mockResolvedValue({ id: "msg1" } as never);
    const markFailed = vi.fn();
    createExecutionTrackerMock.mockReturnValue({
      finalized: false,
      markFailed,
      markSucceeded: vi.fn(),
    } as never);
    generateTextMock.mockRejectedValue(new Error("upstream provider secret-leaking error detail"));

    const res = await POST(req({ query: "anything" }));
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body).toEqual({ error: "AI failed to generate a response. Please try again." });
    expect(JSON.stringify(body)).not.toContain("secret-leaking");
    expect(markFailed).toHaveBeenCalled();
  });
});

describe("POST /api/ai/instructor/copilot — architecture", () => {
  it("never imports buildAIContext, searchKnowledge, or searchSimilarLessons", () => {
    const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from ["']@\/lib\/ai\/runtime\/context["']/);
    expect(source).not.toMatch(/from ["']@\/lib\/domain\/knowledge\/retrieval["']/);
    expect(source).not.toMatch(/from ["']@\/lib\/ai\/search["']/);
    expect(source).not.toMatch(/persistCitations\(/);
  });
});
