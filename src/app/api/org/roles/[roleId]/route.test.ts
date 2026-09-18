import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/context", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/context")>("@/lib/auth/context");
  return { ...actual, requireAuthContext: vi.fn(), requireTenant: vi.fn(), requireRole: vi.fn() };
});

vi.mock("@/lib/domain/capability/roleManagement", async () => {
  const actual = await vi.importActual<typeof import("@/lib/domain/capability/roleManagement")>(
    "@/lib/domain/capability/roleManagement"
  );
  return { ...actual, getJobRoleDetail: vi.fn(), updateJobRole: vi.fn(), deleteJobRole: vi.fn() };
});

const { AuthContextError, requireAuthContext, requireTenant, requireRole } = await import(
  "@/lib/auth/context"
);
const { getJobRoleDetail, updateJobRole, deleteJobRole, RoleManagementError } = await import(
  "@/lib/domain/capability/roleManagement"
);
const { GET, PATCH, DELETE } = await import("./route");

const requireAuthContextMock = vi.mocked(requireAuthContext);
const requireTenantMock = vi.mocked(requireTenant);
const requireRoleMock = vi.mocked(requireRole);
const getDetailMock = vi.mocked(getJobRoleDetail);
const updateMock = vi.mocked(updateJobRole);
const deleteMock = vi.mocked(deleteJobRole);

const params = () => Promise.resolve({ roleId: "r1" });
const req = () => new Request("http://localhost/api/org/roles/r1");
const patchReq = (body: unknown) =>
  new Request("http://localhost/api/org/roles/r1", {
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

function mockDenied(role: "STUDENT" | "INSTRUCTOR" | "SUPER_ADMIN") {
  requireAuthContextMock.mockResolvedValue({ userId: "u1", clerkId: "c1", tenantId: "t1", role });
  requireTenantMock.mockImplementation(() => {});
  requireRoleMock.mockImplementation(() => {
    throw new AuthContextError(403, "Forbidden");
  });
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/org/roles/:roleId", () => {
  it("unauthenticated -> 401", async () => {
    requireAuthContextMock.mockRejectedValue(new AuthContextError(401, "Unauthorized"));
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(401);
  });

  it("SUPER_ADMIN -> 403", async () => {
    mockDenied("SUPER_ADMIN");
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(403);
  });

  it("cross-tenant / nonexistent -> 404", async () => {
    mockAsOrgAdmin();
    getDetailMock.mockRejectedValue(new RoleManagementError(404, "Role not found"));
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(404);
  });

  it("ORG_ADMIN -> 200 with detail", async () => {
    mockAsOrgAdmin();
    getDetailMock.mockResolvedValue({
      id: "r1",
      name: "Engineer",
      description: null,
      createdAt: new Date(),
      roleSkills: [],
      assignedUsers: [],
    });
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(200);
  });
});

describe("PATCH /api/org/roles/:roleId", () => {
  it("STUDENT -> 403", async () => {
    mockDenied("STUDENT");
    const res = await PATCH(patchReq({ name: "New name" }), { params: params() });
    expect(res.status).toBe(403);
  });

  it("rename to duplicate -> 409", async () => {
    mockAsOrgAdmin();
    updateMock.mockRejectedValue(
      new RoleManagementError(409, "A role with this name already exists")
    );
    const res = await PATCH(patchReq({ name: "Existing" }), { params: params() });
    expect(res.status).toBe(409);
  });

  it("ORG_ADMIN -> 200 with updated role", async () => {
    mockAsOrgAdmin();
    updateMock.mockResolvedValue({
      id: "r1",
      name: "New name",
      description: null,
      createdAt: new Date(),
    });
    const res = await PATCH(patchReq({ name: "New name" }), { params: params() });
    expect(res.status).toBe(200);
  });
});

describe("DELETE /api/org/roles/:roleId", () => {
  it("INSTRUCTOR -> 403", async () => {
    mockDenied("INSTRUCTOR");
    const res = await DELETE(req(), { params: params() });
    expect(res.status).toBe(403);
  });

  it("role has assigned users -> 409", async () => {
    mockAsOrgAdmin();
    deleteMock.mockRejectedValue(
      new RoleManagementError(409, "Remove all assigned users before deleting this role")
    );
    const res = await DELETE(req(), { params: params() });
    expect(res.status).toBe(409);
  });

  it("ORG_ADMIN, empty role -> 204", async () => {
    mockAsOrgAdmin();
    deleteMock.mockResolvedValue(undefined);
    const res = await DELETE(req(), { params: params() });
    expect(res.status).toBe(204);
  });
});
