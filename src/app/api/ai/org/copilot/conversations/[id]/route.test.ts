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

const req = () => new Request("http://localhost/api/ai/org/copilot/conversations/conv1");
const params = (id = "conv1") => ({ params: Promise.resolve({ id }) });

function mockAuthenticatedOrgAdmin() {
  requireAuthContextMock.mockResolvedValue({
    userId: "admin-1",
    clerkId: "c1",
    tenantId: "t1",
    role: "ORG_ADMIN",
  });
  requireTenantMock.mockImplementation(() => {});
  requireRoleMock.mockImplementation(() => {});
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/ai/org/copilot/conversations/[id]", () => {
  it("unauthenticated -> 401", async () => {
    requireAuthContextMock.mockRejectedValue(new AuthContextError(401, "Unauthorized"));
    const res = await GET(req(), params());
    expect(res.status).toBe(401);
  });

  it("own conversation -> 200", async () => {
    mockAuthenticatedOrgAdmin();
    getConversationMock.mockResolvedValue({
      id: "conv1",
      createdAt: new Date(),
      contextMetadata: { surface: "ORG_COPILOT" },
    } as never);
    listMessagesMock.mockResolvedValue([]);

    const res = await GET(req(), params());

    expect(res.status).toBe(200);
    expect(getConversationMock).toHaveBeenCalledWith(
      { tenantId: "t1", userId: "admin-1" },
      "conv1",
      "ORG_COPILOT"
    );
  });

  it("another ORG_ADMIN's conversation -> 404, no staff override", async () => {
    mockAuthenticatedOrgAdmin();
    getConversationMock.mockResolvedValue(null);

    const res = await GET(req(), params("other-admin-conv"));
    expect(res.status).toBe(404);
  });

  it("an Instructor Copilot conversation id reused here -> 404 (surface isolation)", async () => {
    mockAuthenticatedOrgAdmin();
    getConversationMock.mockResolvedValue(null);

    const res = await GET(req(), params("instructor-conv"));

    expect(res.status).toBe(404);
    expect(getConversationMock).toHaveBeenCalledWith(
      expect.anything(),
      "instructor-conv",
      "ORG_COPILOT"
    );
  });

  it("cross-tenant conversation id -> 404", async () => {
    mockAuthenticatedOrgAdmin();
    getConversationMock.mockResolvedValue(null);

    const res = await GET(req(), params("cross-tenant-conv"));
    expect(res.status).toBe(404);
  });
});
