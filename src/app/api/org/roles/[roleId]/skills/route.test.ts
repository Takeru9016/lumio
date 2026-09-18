import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/context", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/context")>("@/lib/auth/context");
  return { ...actual, requireAuthContext: vi.fn(), requireTenant: vi.fn(), requireRole: vi.fn() };
});

vi.mock("@/lib/domain/capability/roleManagement", async () => {
  const actual = await vi.importActual<typeof import("@/lib/domain/capability/roleManagement")>(
    "@/lib/domain/capability/roleManagement"
  );
  return { ...actual, addRoleSkill: vi.fn() };
});

const { AuthContextError, requireAuthContext, requireTenant, requireRole } = await import(
  "@/lib/auth/context"
);
const { addRoleSkill, RoleManagementError } = await import(
  "@/lib/domain/capability/roleManagement"
);
const { POST } = await import("./route");

const requireAuthContextMock = vi.mocked(requireAuthContext);
const requireTenantMock = vi.mocked(requireTenant);
const requireRoleMock = vi.mocked(requireRole);
const addMock = vi.mocked(addRoleSkill);

const params = () => Promise.resolve({ roleId: "r1" });
const postReq = (body: unknown) =>
  new Request("http://localhost/api/org/roles/r1/skills", {
    method: "POST",
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

describe("POST /api/org/roles/:roleId/skills", () => {
  it("unauthenticated -> 401", async () => {
    requireAuthContextMock.mockRejectedValue(new AuthContextError(401, "Unauthorized"));
    const res = await POST(postReq({ skillId: "s1", requiredProficiency: "BEGINNER" }), {
      params: params(),
    });
    expect(res.status).toBe(401);
  });

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
    const res = await POST(postReq({ skillId: "s1", requiredProficiency: "BEGINNER" }), {
      params: params(),
    });
    expect(res.status).toBe(403);
  });

  it("duplicate (roleId, skillId) -> 409", async () => {
    mockAsOrgAdmin();
    addMock.mockRejectedValue(
      new RoleManagementError(409, "This skill is already required by this role")
    );
    const res = await POST(postReq({ skillId: "s1", requiredProficiency: "BEGINNER" }), {
      params: params(),
    });
    expect(res.status).toBe(409);
  });

  it("invalid proficiency (e.g. NONE) -> 400", async () => {
    mockAsOrgAdmin();
    addMock.mockRejectedValue(
      new RoleManagementError(
        400,
        "requiredProficiency must be one of BEGINNER, INTERMEDIATE, ADVANCED, EXPERT"
      )
    );
    const res = await POST(postReq({ skillId: "s1", requiredProficiency: "NONE" }), {
      params: params(),
    });
    expect(res.status).toBe(400);
  });

  it("cross-tenant skillId -> 404", async () => {
    mockAsOrgAdmin();
    addMock.mockRejectedValue(new RoleManagementError(404, "Skill not found"));
    const res = await POST(postReq({ skillId: "s1", requiredProficiency: "BEGINNER" }), {
      params: params(),
    });
    expect(res.status).toBe(404);
  });

  it("ORG_ADMIN -> 201", async () => {
    mockAsOrgAdmin();
    addMock.mockResolvedValue({
      skillId: "s1",
      requiredProficiency: "BEGINNER",
      skill: { name: "React" },
    });
    const res = await POST(postReq({ skillId: "s1", requiredProficiency: "BEGINNER" }), {
      params: params(),
    });
    expect(res.status).toBe(201);
  });
});
