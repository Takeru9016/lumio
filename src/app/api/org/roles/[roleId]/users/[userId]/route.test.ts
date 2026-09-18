import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/context", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/context")>("@/lib/auth/context");
  return { ...actual, requireAuthContext: vi.fn(), requireTenant: vi.fn(), requireRole: vi.fn() };
});

vi.mock("@/lib/domain/capability/roleManagement", async () => {
  const actual = await vi.importActual<typeof import("@/lib/domain/capability/roleManagement")>(
    "@/lib/domain/capability/roleManagement"
  );
  return { ...actual, changePrimaryUserJobRole: vi.fn(), removeUserJobRole: vi.fn() };
});

const { AuthContextError, requireAuthContext, requireTenant, requireRole } = await import(
  "@/lib/auth/context"
);
const { changePrimaryUserJobRole, removeUserJobRole, RoleManagementError } = await import(
  "@/lib/domain/capability/roleManagement"
);
const { PATCH, DELETE } = await import("./route");

const requireAuthContextMock = vi.mocked(requireAuthContext);
const requireTenantMock = vi.mocked(requireTenant);
const requireRoleMock = vi.mocked(requireRole);
const changePrimaryMock = vi.mocked(changePrimaryUserJobRole);
const removeMock = vi.mocked(removeUserJobRole);

const params = () => Promise.resolve({ roleId: "r1", userId: "u2" });
const req = () => new Request("http://localhost/api/org/roles/r1/users/u2");
const patchReq = (body: unknown) =>
  new Request("http://localhost/api/org/roles/r1/users/u2", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

function mockAsOrgAdmin() {
  requireAuthContextMock.mockResolvedValue({
    userId: "u1",
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

describe("PATCH /api/org/roles/:roleId/users/:userId", () => {
  it("unauthenticated -> 401", async () => {
    requireAuthContextMock.mockRejectedValue(new AuthContextError(401, "Unauthorized"));
    const res = await PATCH(patchReq({ isPrimary: true }), { params: params() });
    expect(res.status).toBe(401);
  });

  it("isPrimary !== true -> 400", async () => {
    mockAsOrgAdmin();
    const res = await PATCH(patchReq({ isPrimary: false }), { params: params() });
    expect(res.status).toBe(400);
  });

  it("not assigned -> 404", async () => {
    mockAsOrgAdmin();
    changePrimaryMock.mockRejectedValue(
      new RoleManagementError(404, "This user does not have this role assigned")
    );
    const res = await PATCH(patchReq({ isPrimary: true }), { params: params() });
    expect(res.status).toBe(404);
  });

  it("ORG_ADMIN -> 200, previous primary demoted", async () => {
    mockAsOrgAdmin();
    changePrimaryMock.mockResolvedValue({
      userId: "u2",
      roleId: "r1",
      isPrimary: true,
      assignedAt: new Date(),
    });
    const res = await PATCH(patchReq({ isPrimary: true }), { params: params() });
    expect(res.status).toBe(200);
    expect(changePrimaryMock).toHaveBeenCalledWith(expect.anything(), "r1", "u2");
  });
});

describe("DELETE /api/org/roles/:roleId/users/:userId", () => {
  it("SUPER_ADMIN -> 403", async () => {
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
    const res = await DELETE(req(), { params: params() });
    expect(res.status).toBe(403);
  });

  it("ORG_ADMIN -> 204 (no automatic promotion)", async () => {
    mockAsOrgAdmin();
    removeMock.mockResolvedValue(undefined);
    const res = await DELETE(req(), { params: params() });
    expect(res.status).toBe(204);
  });
});
