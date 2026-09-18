import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/context", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/context")>("@/lib/auth/context");
  return { ...actual, requireAuthContext: vi.fn(), requireTenant: vi.fn(), requireRole: vi.fn() };
});

vi.mock("@/lib/domain/capability/roleManagement", async () => {
  const actual = await vi.importActual<typeof import("@/lib/domain/capability/roleManagement")>(
    "@/lib/domain/capability/roleManagement"
  );
  return { ...actual, updateRoleSkill: vi.fn(), removeRoleSkill: vi.fn() };
});

const { AuthContextError, requireAuthContext, requireTenant, requireRole } = await import(
  "@/lib/auth/context"
);
const { updateRoleSkill, removeRoleSkill, RoleManagementError } = await import(
  "@/lib/domain/capability/roleManagement"
);
const { PATCH, DELETE } = await import("./route");

const requireAuthContextMock = vi.mocked(requireAuthContext);
const requireTenantMock = vi.mocked(requireTenant);
const requireRoleMock = vi.mocked(requireRole);
const updateMock = vi.mocked(updateRoleSkill);
const removeMock = vi.mocked(removeRoleSkill);

const params = () => Promise.resolve({ roleId: "r1", skillId: "s1" });
const req = () => new Request("http://localhost/api/org/roles/r1/skills/s1");
const patchReq = (body: unknown) =>
  new Request("http://localhost/api/org/roles/r1/skills/s1", {
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

describe("PATCH /api/org/roles/:roleId/skills/:skillId", () => {
  it("unauthenticated -> 401", async () => {
    requireAuthContextMock.mockRejectedValue(new AuthContextError(401, "Unauthorized"));
    const res = await PATCH(patchReq({ requiredProficiency: "ADVANCED" }), { params: params() });
    expect(res.status).toBe(401);
  });

  it("STUDENT -> 403", async () => {
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
    const res = await PATCH(patchReq({ requiredProficiency: "ADVANCED" }), { params: params() });
    expect(res.status).toBe(403);
  });

  it("ORG_ADMIN -> 200 with updated requirement", async () => {
    mockAsOrgAdmin();
    updateMock.mockResolvedValue({ skillId: "s1", requiredProficiency: "ADVANCED" });
    const res = await PATCH(patchReq({ requiredProficiency: "ADVANCED" }), { params: params() });
    expect(res.status).toBe(200);
  });
});

describe("DELETE /api/org/roles/:roleId/skills/:skillId", () => {
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

  it("not found -> 404", async () => {
    mockAsOrgAdmin();
    removeMock.mockRejectedValue(
      new RoleManagementError(404, "This skill is not required by this role")
    );
    const res = await DELETE(req(), { params: params() });
    expect(res.status).toBe(404);
  });

  it("ORG_ADMIN -> 204", async () => {
    mockAsOrgAdmin();
    removeMock.mockResolvedValue(undefined);
    const res = await DELETE(req(), { params: params() });
    expect(res.status).toBe(204);
  });
});
