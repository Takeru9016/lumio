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
const req = () => new Request("http://localhost/api/ai/org/copilot/conversations");

afterEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/ai/org/copilot/conversations", () => {
  it("unauthenticated -> 401", async () => {
    requireAuthContextMock.mockRejectedValue(new AuthContextError(401, "Unauthorized"));
    const res = await GET(req());
    expect(res.status).toBe(401);
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

  it("SUPER_ADMIN -> 403, no shortcut, even though SUPER_ADMIN has platform-wide authority elsewhere", async () => {
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

  it("ORG_ADMIN -> 200, scoped to caller + ORG_COPILOT — never another ORG_ADMIN's conversations", async () => {
    requireAuthContextMock.mockResolvedValue({
      userId: "admin-1",
      clerkId: "c1",
      tenantId: "t1",
      role: "ORG_ADMIN",
    });
    requireTenantMock.mockImplementation(() => {});
    requireRoleMock.mockImplementation(() => {});
    listMock.mockResolvedValue([]);

    const res = await GET(req());

    expect(res.status).toBe(200);
    expect(listMock).toHaveBeenCalledWith({ tenantId: "t1", userId: "admin-1" }, "ORG_COPILOT");
  });
});
