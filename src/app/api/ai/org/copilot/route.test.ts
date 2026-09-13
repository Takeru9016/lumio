import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level test for POST /api/ai/org/copilot, mirroring
 * instructor/copilot/route.test.ts's pattern for the ORG_ADMIN-only surface.
 */
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
}));

vi.mock("@/lib/ai/middleware", () => ({
  withAiGuards: vi.fn(),
}));

vi.mock("@/lib/ratelimit", () => ({
  orgCopilotRatelimit: {},
}));

vi.mock("ai", () => ({
  generateText: vi.fn(),
}));

vi.mock("@/lib/domain/capability/organizationCopilotContext", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/domain/capability/organizationCopilotContext")
  >("@/lib/domain/capability/organizationCopilotContext");
  return {
    OrganizationCopilotLearnerNotFoundError: actual.OrganizationCopilotLearnerNotFoundError,
    buildOrganizationCopilotContext: vi.fn(),
  };
});

vi.mock("@/lib/ai/runtime/provider", () => ({
  modelFor: vi.fn(() => ({ model: {}, provider: "openai", modelId: "gpt-5.4-mini" })),
}));

vi.mock("@/lib/ai/runtime/persistence", () => ({
  createConversation: vi.fn(),
  startExecution: vi.fn(),
  persistMessage: vi.fn(),
  recordUsageEvent: vi.fn(),
}));

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
const { buildOrganizationCopilotContext, OrganizationCopilotLearnerNotFoundError } = await import(
  "@/lib/domain/capability/organizationCopilotContext"
);
const { createConversation, startExecution, persistMessage, recordUsageEvent } = await import(
  "@/lib/ai/runtime/persistence"
);
const { createExecutionTracker } = await import("@/lib/ai/runtime/execution");
const { incrementAiUsage } = await import("@/lib/ai/quota");
const { POST } = await import("./route");

const authMock = vi.mocked(auth);
const withAiGuardsMock = vi.mocked(withAiGuards);
const generateTextMock = vi.mocked(generateText);
const buildContextMock = vi.mocked(buildOrganizationCopilotContext);
const createConversationMock = vi.mocked(createConversation);
const startExecutionMock = vi.mocked(startExecution);
const persistMessageMock = vi.mocked(persistMessage);
const recordUsageEventMock = vi.mocked(recordUsageEvent);
const createExecutionTrackerMock = vi.mocked(createExecutionTracker);
const incrementAiUsageMock = vi.mocked(incrementAiUsage);

const req = (body: unknown) =>
  new Request("http://localhost/api/ai/org/copilot", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

function mockUser(overrides: Partial<{ tenantId: string | null; role: string }> = {}) {
  const user = { id: "u1", tenantId: "t1", role: "ORG_ADMIN", plan: "PRO", ...overrides };
  withAiGuardsMock.mockResolvedValue({ ok: true, user } as never);
  authMock.mockResolvedValue({ userId: "c1" } as never);
  return user;
}

const COHORT_CONTEXT = {
  scope: "cohort",
  cohortSize: 2,
  cohortTruncated: false,
  roleBreakdown: [
    { roleName: "Sales Rep", learnerCount: 1 },
    { roleName: "Support", learnerCount: 1 },
  ],
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

describe("POST /api/ai/org/copilot — authentication & authorization", () => {
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

  it("ORG_ADMIN -> allowed (200)", async () => {
    mockUser({ role: "ORG_ADMIN" });
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

  it("INSTRUCTOR -> 403", async () => {
    mockUser({ role: "INSTRUCTOR" });
    const res = await POST(req({ query: "hello" }));
    expect(res.status).toBe(403);
  });

  it("SUPER_ADMIN -> 403, no shortcut", async () => {
    mockUser({ role: "SUPER_ADMIN" });
    const res = await POST(req({ query: "hello" }));
    expect(res.status).toBe(403);
  });
});

describe("POST /api/ai/org/copilot — request validation", () => {
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

  it("learnerId is accepted as a valid field", async () => {
    mockUser();
    buildContextMock.mockResolvedValue({
      scope: "learner",
      cohortSize: 1,
      cohortTruncated: false,
      roleBreakdown: [],
      skillAggregates: [],
      learner: { learnerName: "Cid", roleName: "Support", skills: [] },
    } as never);
    mockPersistenceHappyPath();
    generateTextMock.mockResolvedValue({ text: "Cid is on track.", usage: {} } as never);

    const res = await POST(req({ query: "Tell me about this learner", learnerId: "u2" }));
    expect(res.status).toBe(200);
  });
});

describe("POST /api/ai/org/copilot — learnerId security", () => {
  it("learnerId is passed to buildOrganizationCopilotContext with the authenticated ctx", async () => {
    mockUser();
    buildContextMock.mockResolvedValue(COHORT_CONTEXT as never);
    mockPersistenceHappyPath();
    generateTextMock.mockResolvedValue({ text: "Answer.", usage: {} } as never);

    await POST(req({ query: "Tell me about this learner", learnerId: "u2" }));

    expect(buildContextMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", tenantId: "t1", role: "ORG_ADMIN" }),
      { learnerId: "u2" }
    );
  });

  it("learnerId not found in the authorized page -> 404, generic message", async () => {
    mockUser();
    buildContextMock.mockRejectedValue(new OrganizationCopilotLearnerNotFoundError());

    const res = await POST(
      req({ query: "Tell me about this learner", learnerId: "not-in-tenant" })
    );
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ error: "Learner not found in your capability report" });
  });
});

describe("POST /api/ai/org/copilot — AI contract", () => {
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
    expect(call.system).toContain("Support");
    expect(call.system).toContain("Negotiation");
  });
});

describe("POST /api/ai/org/copilot — response shape", () => {
  it("successful response is exactly { answer }", async () => {
    mockUser();
    buildContextMock.mockResolvedValue(COHORT_CONTEXT as never);
    mockPersistenceHappyPath();
    generateTextMock.mockResolvedValue({ text: "Focus on Negotiation.", usage: {} } as never);

    const res = await POST(req({ query: "What should I focus on?" }));
    const body = await res.json();

    expect(body).toEqual({ answer: "Focus on Negotiation." });
  });
});

describe("POST /api/ai/org/copilot — persistence", () => {
  it("persists AIConversation(GENERAL)/user+assistant AIMessage/AIExecution/AIUsageEvent with operation capability.org.copilot, no citations", async () => {
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
      expect.objectContaining({ operation: "capability.org.copilot", conversationId: "conv1" })
    );
    expect(persistMessageMock).toHaveBeenCalledWith("conv1", "user", "Which skills are missing?");
    expect(persistMessageMock).toHaveBeenCalledWith("conv1", "assistant", "Answer.");
    expect(recordUsageEventMock).toHaveBeenCalledWith(
      { tenantId: "t1", userId: "u1" },
      expect.objectContaining({ operation: "capability.org.copilot", executionId: "exec1" })
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

describe("POST /api/ai/org/copilot — generation failure", () => {
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

describe("POST /api/ai/org/copilot — architecture", () => {
  it("never imports buildAIContext, searchKnowledge, or searchSimilarLessons", () => {
    const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from ["']@\/lib\/ai\/runtime\/context["']/);
    expect(source).not.toMatch(/from ["']@\/lib\/domain\/knowledge\/retrieval["']/);
    expect(source).not.toMatch(/from ["']@\/lib\/ai\/search["']/);
    expect(source).not.toMatch(/persistCitations\(/);
  });
});
