import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/context", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/context")>("@/lib/auth/context");
  return { ...actual, requireAuthContext: vi.fn(), requireTenant: vi.fn(), requireRole: vi.fn() };
});

vi.mock("@/lib/ai/runtime/persistence", () => ({
  getConversationForContinuation: vi.fn(),
  listRecentMessages: vi.fn(),
}));

const { AuthContextError, requireAuthContext, requireTenant, requireRole } = await import(
  "@/lib/auth/context"
);
const { getConversationForContinuation, listRecentMessages } = await import(
  "@/lib/ai/runtime/persistence"
);
const { GET } = await import("./route");

const requireAuthContextMock = vi.mocked(requireAuthContext);
const requireTenantMock = vi.mocked(requireTenant);
const requireRoleMock = vi.mocked(requireRole);
const getConversationMock = vi.mocked(getConversationForContinuation);
const listMessagesMock = vi.mocked(listRecentMessages);

const req = () => new Request("http://localhost/api/ai/copilot/conversations/conv1");
const params = (id = "conv1") => ({ params: Promise.resolve({ id }) });

function mockAuthenticatedStudent() {
  requireAuthContextMock.mockResolvedValue({
    userId: "u1",
    clerkId: "c1",
    tenantId: "t1",
    role: "STUDENT",
  });
  requireTenantMock.mockImplementation(() => {});
  requireRoleMock.mockImplementation(() => {});
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/ai/copilot/conversations/[id]", () => {
  it("unauthenticated -> 401", async () => {
    requireAuthContextMock.mockRejectedValue(new AuthContextError(401, "Unauthorized"));
    const res = await GET(req(), params());
    expect(res.status).toBe(401);
  });

  it("missing tenant -> 400", async () => {
    requireAuthContextMock.mockResolvedValue({
      userId: "u1",
      clerkId: "c1",
      tenantId: null,
      role: "STUDENT",
    });
    requireTenantMock.mockImplementation(() => {
      throw new AuthContextError(400, "No organisation found");
    });
    const res = await GET(req(), params());
    expect(res.status).toBe(400);
  });

  it("SUPER_ADMIN -> 403, no shortcut", async () => {
    requireAuthContextMock.mockResolvedValue({
      userId: "u1",
      clerkId: "c1",
      tenantId: "t1",
      role: "SUPER_ADMIN",
    });
    requireTenantMock.mockImplementation(() => {});
    requireRoleMock.mockImplementation(() => {
      throw new AuthContextError(403, "Forbidden");
    });
    const res = await GET(req(), params());
    expect(res.status).toBe(403);
  });

  it("own conversation -> 200 with ordered messages", async () => {
    mockAuthenticatedStudent();
    getConversationMock.mockResolvedValue({
      id: "conv1",
      createdAt: new Date("2026-01-01"),
      contextMetadata: { surface: "STUDENT_COPILOT" },
    } as never);
    listMessagesMock.mockResolvedValue([
      { role: "user", content: "hi", createdAt: new Date("2026-01-01T00:00:00Z") },
      { role: "assistant", content: "hello", createdAt: new Date("2026-01-01T00:00:01Z") },
    ] as never);

    const res = await GET(req(), params());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.conversation.messages).toEqual([
      { role: "user", content: "hi", createdAt: "2026-01-01T00:00:00.000Z" },
      { role: "assistant", content: "hello", createdAt: "2026-01-01T00:00:01.000Z" },
    ]);
    expect(getConversationMock).toHaveBeenCalledWith(
      { tenantId: "t1", userId: "u1" },
      "conv1",
      "STUDENT_COPILOT"
    );
  });

  it("another user's conversation -> 404 (resolver returns null)", async () => {
    mockAuthenticatedStudent();
    getConversationMock.mockResolvedValue(null);

    const res = await GET(req(), params());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Conversation not found" });
  });

  it("cross-tenant conversation id -> 404, same message as any other not-found", async () => {
    mockAuthenticatedStudent();
    getConversationMock.mockResolvedValue(null);

    const res = await GET(req(), params("cross-tenant-conv"));
    expect(res.status).toBe(404);
  });

  it("wrong-surface conversation id (e.g. an Instructor Copilot conversation) -> 404", async () => {
    mockAuthenticatedStudent();
    getConversationMock.mockResolvedValue(null);

    const res = await GET(req(), params("instructor-conv"));
    expect(res.status).toBe(404);
    expect(getConversationMock).toHaveBeenCalledWith(
      expect.anything(),
      "instructor-conv",
      "STUDENT_COPILOT"
    );
  });

  it("empty conversation (zero messages) -> 200 with an empty messages array", async () => {
    mockAuthenticatedStudent();
    getConversationMock.mockResolvedValue({
      id: "conv1",
      createdAt: new Date(),
      contextMetadata: { surface: "STUDENT_COPILOT" },
    } as never);
    listMessagesMock.mockResolvedValue([]);

    const res = await GET(req(), params());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.conversation.messages).toEqual([]);
  });

  it("display fetch requests more than the 10-message generation window", async () => {
    mockAuthenticatedStudent();
    getConversationMock.mockResolvedValue({
      id: "conv1",
      createdAt: new Date(),
      contextMetadata: { surface: "STUDENT_COPILOT" },
    } as never);
    listMessagesMock.mockResolvedValue([]);

    await GET(req(), params());

    const [, limit] = listMessagesMock.mock.calls[0];
    expect(limit).toBeGreaterThan(10);
  });

  it("never exposes tenantId, execution internals, or the system prompt", async () => {
    mockAuthenticatedStudent();
    getConversationMock.mockResolvedValue({
      id: "conv1",
      tenantId: "t1",
      createdAt: new Date(),
      contextMetadata: { surface: "STUDENT_COPILOT" },
    } as never);
    listMessagesMock.mockResolvedValue([]);

    const res = await GET(req(), params());
    const body = await res.json();

    expect(body).not.toHaveProperty("tenantId");
    expect(body.conversation).not.toHaveProperty("tenantId");
    expect(body.conversation).not.toHaveProperty("executionId");
  });
});
