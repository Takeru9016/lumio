import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/context", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/context")>("@/lib/auth/context");
  return { ...actual, requireAuthContext: vi.fn(), requireTenant: vi.fn(), requireRole: vi.fn() };
});

vi.mock("@/lib/domain/capability/roleManagement", async () => {
  const actual = await vi.importActual<typeof import("@/lib/domain/capability/roleManagement")>(
    "@/lib/domain/capability/roleManagement"
  );
  return { ...actual, listJobRoles: vi.fn(), createJobRole: vi.fn() };
});

const { AuthContextError, requireAuthContext, requireTenant, requireRole } = await import(
  "@/lib/auth/context"
);
const { listJobRoles, createJobRole, RoleManagementError } = await import(
  "@/lib/domain/capability/roleManagement"
);
const { GET, POST } = await import("./route");

const requireAuthContextMock = vi.mocked(requireAuthContext);
const requireTenantMock = vi.mocked(requireTenant);
const requireRoleMock = vi.mocked(requireRole);
const listMock = vi.mocked(listJobRoles);
const createMock = vi.mocked(createJobRole);

const req = () => new Request("http://localhost/api/org/roles");
const postReq = (body: unknown) =>
  new Request("http://localhost/api/org/roles", {
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

describe("GET /api/org/roles", () => {
  it("unauthenticated -> 401", async () => {
    requireAuthContextMock.mockRejectedValue(new AuthContextError(401, "Unauthorized"));
    const res = await GET(req());
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
    const res = await GET(req());
    expect(res.status).toBe(403);
  });

  it("INSTRUCTOR -> 403", async () => {
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
    const res = await GET(req());
    expect(res.status).toBe(403);
  });

  it("ORG_ADMIN -> 200 with the listing", async () => {
    mockAsOrgAdmin();
    listMock.mockResolvedValue([
      {
        id: "r1",
        name: "Engineer",
        description: null,
        createdAt: new Date(),
        skillCount: 0,
        assignedUserCount: 0,
      },
    ]);
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.roles).toHaveLength(1);
  });
});

describe("POST /api/org/roles", () => {
  it("unauthenticated -> 401", async () => {
    requireAuthContextMock.mockRejectedValue(new AuthContextError(401, "Unauthorized"));
    const res = await POST(postReq({ name: "Engineer" }));
    expect(res.status).toBe(401);
  });

  it("no tenant -> 400", async () => {
    requireAuthContextMock.mockResolvedValue({
      userId: "u1",
      clerkId: "c1",
      tenantId: null,
      role: "ORG_ADMIN",
    });
    requireTenantMock.mockImplementation(() => {
      throw new AuthContextError(400, "No organisation found");
    });
    const res = await POST(postReq({ name: "Engineer" }));
    expect(res.status).toBe(400);
  });

  it("ORG_ADMIN -> 201 with created role", async () => {
    mockAsOrgAdmin();
    createMock.mockResolvedValue({
      id: "r1",
      name: "Engineer",
      description: null,
      createdAt: new Date(),
    });
    const res = await POST(postReq({ name: "Engineer" }));
    expect(res.status).toBe(201);
  });

  it("duplicate name -> 409", async () => {
    mockAsOrgAdmin();
    createMock.mockRejectedValue(
      new RoleManagementError(409, "A role with this name already exists")
    );
    const res = await POST(postReq({ name: "Engineer" }));
    expect(res.status).toBe(409);
  });

  it("invalid name -> 400", async () => {
    mockAsOrgAdmin();
    createMock.mockRejectedValue(
      new RoleManagementError(400, "Name must be between 1 and 100 characters")
    );
    const res = await POST(postReq({ name: "" }));
    expect(res.status).toBe(400);
  });
});
