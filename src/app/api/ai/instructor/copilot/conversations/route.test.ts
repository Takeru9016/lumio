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
const req = () => new Request("http://localhost/api/ai/instructor/copilot/conversations");

afterEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/ai/instructor/copilot/conversations", () => {
  it("unauthenticated -> 401", async () => {
    requireAuthContextMock.mockRejectedValue(new AuthContextError(401, "Unauthorized"));
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it("STUDENT -> 403 (wrong role)", async () => {
    requireAuthContextMock.mockResolvedValue({
      userId: "u1",
      clerkId: "c1",
      tenantId: "t1",
      role: "STUDENT",
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

  it("INSTRUCTOR -> 200, scoped to caller + INSTRUCTOR_COPILOT — never another instructor's conversations", async () => {
    requireAuthContextMock.mockResolvedValue({
      userId: "instructor-1",
      clerkId: "c1",
      tenantId: "t1",
      role: "INSTRUCTOR",
    });
    requireTenantMock.mockImplementation(() => {});
    requireRoleMock.mockImplementation(() => {});
    listMock.mockResolvedValue([]);

    const res = await GET(req());

    expect(res.status).toBe(200);
    expect(listMock).toHaveBeenCalledWith(
      { tenantId: "t1", userId: "instructor-1" },
      "INSTRUCTOR_COPILOT"
    );
  });
});
