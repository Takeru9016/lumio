import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/context", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/context")>("@/lib/auth/context");
  return { ...actual, requireAuthContext: vi.fn(), requireTenant: vi.fn(), requireRole: vi.fn() };
});

vi.mock("@/lib/ai/runtime/persistence", () => ({
  listConversationsForUser: vi.fn(),
}));

const { AuthContextError, requireAuthContext, requireTenant, requireRole } = await import(
  "@/lib/auth/context"
);
const { listConversationsForUser } = await import("@/lib/ai/runtime/persistence");
const { GET } = await import("./route");

const requireAuthContextMock = vi.mocked(requireAuthContext);
const requireTenantMock = vi.mocked(requireTenant);
const requireRoleMock = vi.mocked(requireRole);
const listMock = vi.mocked(listConversationsForUser);
const req = () => new Request("http://localhost/api/ai/copilot/conversations");

afterEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/ai/copilot/conversations", () => {
  it("unauthenticated -> 401", async () => {
    requireAuthContextMock.mockRejectedValue(new AuthContextError(401, "Unauthorized"));
    const res = await GET(req());
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
    const res = await GET(req());
    expect(res.status).toBe(400);
  });

  it("INSTRUCTOR -> 403 (wrong role)", async () => {
    requireAuthContextMock.mockResolvedValue({
      userId: "u1",
      clerkId: "c1",
      tenantId: "t1",
      role: "INSTRUCTOR",
    });
    requireTenantMock.mockImplementation(() => {});
    requireRoleMock.mockImplementation(() => {
      throw new AuthContextError(403, "Forbidden");
    });
    const res = await GET(req());
    expect(res.status).toBe(403);
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
    const res = await GET(req());
    expect(res.status).toBe(403);
  });

  it("STUDENT -> 200, calls listConversationsForUser scoped to the caller + STUDENT_COPILOT", async () => {
    requireAuthContextMock.mockResolvedValue({
      userId: "u1",
      clerkId: "c1",
      tenantId: "t1",
      role: "STUDENT",
    });
    requireTenantMock.mockImplementation(() => {});
    requireRoleMock.mockImplementation(() => {});
    listMock.mockResolvedValue([
      {
        id: "conv1",
        contextMetadata: { surface: "STUDENT_COPILOT", query: "What am I missing?" },
        createdAt: new Date("2026-01-02"),
        updatedAt: new Date("2026-01-02"),
      },
    ] as never);

    const res = await GET(req());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(listMock).toHaveBeenCalledWith({ tenantId: "t1", userId: "u1" }, "STUDENT_COPILOT");
    expect(body.conversations).toEqual([
      {
        id: "conv1",
        label: "What am I missing?",
        createdAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ]);
  });

  it("derives a generic label when no query is present in contextMetadata", async () => {
    requireAuthContextMock.mockResolvedValue({
      userId: "u1",
      clerkId: "c1",
      tenantId: "t1",
      role: "STUDENT",
    });
    requireTenantMock.mockImplementation(() => {});
    requireRoleMock.mockImplementation(() => {});
    listMock.mockResolvedValue([
      { id: "conv1", contextMetadata: null, createdAt: new Date(), updatedAt: new Date() },
    ] as never);

    const res = await GET(req());
    const body = await res.json();

    expect(body.conversations[0].label).toBe("Conversation");
  });

  it("never returns tenantId or userId in the response body", async () => {
    requireAuthContextMock.mockResolvedValue({
      userId: "u1",
      clerkId: "c1",
      tenantId: "t1",
      role: "STUDENT",
    });
    requireTenantMock.mockImplementation(() => {});
    requireRoleMock.mockImplementation(() => {});
    listMock.mockResolvedValue([
      { id: "conv1", contextMetadata: {}, createdAt: new Date(), updatedAt: new Date() },
    ] as never);

    const res = await GET(req());
    const body = await res.json();

    expect(JSON.stringify(body)).not.toContain("tenantId");
    expect(JSON.stringify(body)).not.toContain("t1");
  });
});
