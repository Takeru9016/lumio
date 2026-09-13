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

const req = () => new Request("http://localhost/api/ai/instructor/copilot/conversations/conv1");
const params = (id = "conv1") => ({ params: Promise.resolve({ id }) });

function mockAuthenticatedInstructor() {
  requireAuthContextMock.mockResolvedValue({
    userId: "instructor-1",
    clerkId: "c1",
    tenantId: "t1",
    role: "INSTRUCTOR",
  });
  requireTenantMock.mockImplementation(() => {});
  requireRoleMock.mockImplementation(() => {});
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/ai/instructor/copilot/conversations/[id]", () => {
  it("unauthenticated -> 401", async () => {
    requireAuthContextMock.mockRejectedValue(new AuthContextError(401, "Unauthorized"));
    const res = await GET(req(), params());
    expect(res.status).toBe(401);
  });

  it("own conversation -> 200", async () => {
    mockAuthenticatedInstructor();
    getConversationMock.mockResolvedValue({
      id: "conv1",
      createdAt: new Date(),
      contextMetadata: { surface: "INSTRUCTOR_COPILOT", learnerId: "learner-1" },
    } as never);
    listMessagesMock.mockResolvedValue([]);

    const res = await GET(req(), params());

    expect(res.status).toBe(200);
    expect(getConversationMock).toHaveBeenCalledWith(
      { tenantId: "t1", userId: "instructor-1" },
      "conv1",
      "INSTRUCTOR_COPILOT"
    );
  });

  it("a peer instructor's conversation -> 404 (never disclosed as forbidden, resolver already scopes by userId)", async () => {
    mockAuthenticatedInstructor();
    getConversationMock.mockResolvedValue(null);

    const res = await GET(req(), params("peer-instructor-conv"));
    expect(res.status).toBe(404);
  });

  it("a Student Copilot conversation id reused here -> 404 (surface isolation)", async () => {
    mockAuthenticatedInstructor();
    getConversationMock.mockResolvedValue(null);

    const res = await GET(req(), params("student-conv"));

    expect(res.status).toBe(404);
    expect(getConversationMock).toHaveBeenCalledWith(
      expect.anything(),
      "student-conv",
      "INSTRUCTOR_COPILOT"
    );
  });

  it("an Org Copilot conversation id reused here -> 404 (surface isolation)", async () => {
    mockAuthenticatedInstructor();
    getConversationMock.mockResolvedValue(null);

    const res = await GET(req(), params("org-conv"));
    expect(res.status).toBe(404);
  });
});
