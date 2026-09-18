import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/context", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/context")>("@/lib/auth/context");
  return { ...actual, requireAuthContext: vi.fn(), requireTenant: vi.fn(), requireRole: vi.fn() };
});

vi.mock("@/lib/domain/capability/skillListing", () => ({
  listActiveSkills: vi.fn(),
}));

vi.mock("@/lib/domain/capability/roleManagement", async () => {
  const actual = await vi.importActual<typeof import("@/lib/domain/capability/roleManagement")>(
    "@/lib/domain/capability/roleManagement"
  );
  return { ...actual, createSkillMinimal: vi.fn() };
});

const { AuthContextError, requireAuthContext, requireTenant, requireRole } = await import(
  "@/lib/auth/context"
);
const { listActiveSkills } = await import("@/lib/domain/capability/skillListing");
const { createSkillMinimal } = await import("@/lib/domain/capability/roleManagement");
const { GET, POST } = await import("./route");

const requireAuthContextMock = vi.mocked(requireAuthContext);
const requireTenantMock = vi.mocked(requireTenant);
const requireRoleMock = vi.mocked(requireRole);
const listMock = vi.mocked(listActiveSkills);
const createSkillMock = vi.mocked(createSkillMinimal);
const req = () => new Request("http://localhost/api/skills");
const postReq = (body: unknown) =>
  new Request("http://localhost/api/skills", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

afterEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/skills", () => {
  it("unauthenticated -> 401", async () => {
    requireAuthContextMock.mockRejectedValue(new AuthContextError(401, "Unauthorized"));

    const res = await GET(req());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("authenticated without a tenant -> 400", async () => {
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
    expect(await res.json()).toEqual({ error: "No organisation found" });
  });

  it("valid tenant -> 200 with the listing's result, untouched", async () => {
    requireAuthContextMock.mockResolvedValue({
      userId: "u1",
      clerkId: "c1",
      tenantId: "t1",
      role: "INSTRUCTOR",
    });
    requireTenantMock.mockImplementation(() => {});
    listMock.mockResolvedValue([
      { id: "s1", name: "Skill 1", categoryId: "c1", categoryName: "Category 1" },
    ]);

    const res = await GET(req());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      skills: [{ id: "s1", name: "Skill 1", categoryId: "c1", categoryName: "Category 1" }],
    });
  });

  it("empty tenant -> 200 with an empty array", async () => {
    requireAuthContextMock.mockResolvedValue({
      userId: "u1",
      clerkId: "c1",
      tenantId: "t1",
      role: "INSTRUCTOR",
    });
    requireTenantMock.mockImplementation(() => {});
    listMock.mockResolvedValue([]);

    const res = await GET(req());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skills: [] });
  });

  it("unexpected error -> 500, no internal detail leaked", async () => {
    requireAuthContextMock.mockResolvedValue({
      userId: "u1",
      clerkId: "c1",
      tenantId: "t1",
      role: "INSTRUCTOR",
    });
    requireTenantMock.mockImplementation(() => {});
    listMock.mockRejectedValue(new Error("db exploded"));

    const res = await GET(req());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to list skills" });
  });
});

describe("POST /api/skills", () => {
  it("unauthenticated -> 401", async () => {
    requireAuthContextMock.mockRejectedValue(new AuthContextError(401, "Unauthorized"));

    const res = await POST(postReq({ name: "React" }));

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

    const res = await POST(postReq({ name: "React" }));

    expect(res.status).toBe(403);
  });

  it("ORG_ADMIN -> 201 with created skill", async () => {
    requireAuthContextMock.mockResolvedValue({
      userId: "u1",
      clerkId: "c1",
      tenantId: "t1",
      role: "ORG_ADMIN",
    });
    requireTenantMock.mockImplementation(() => {});
    requireRoleMock.mockImplementation(() => {});
    createSkillMock.mockResolvedValue({ id: "s1", name: "React", description: null });

    const res = await POST(postReq({ name: "React" }));

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "s1", name: "React", description: null });
  });

  it("duplicate name -> 409", async () => {
    requireAuthContextMock.mockResolvedValue({
      userId: "u1",
      clerkId: "c1",
      tenantId: "t1",
      role: "ORG_ADMIN",
    });
    requireTenantMock.mockImplementation(() => {});
    requireRoleMock.mockImplementation(() => {});
    const { RoleManagementError } = await import("@/lib/domain/capability/roleManagement");
    createSkillMock.mockRejectedValue(
      new RoleManagementError(409, "A skill with this name already exists")
    );

    const res = await POST(postReq({ name: "React" }));

    expect(res.status).toBe(409);
  });
});
