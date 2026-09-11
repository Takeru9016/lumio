import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/context", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/context")>("@/lib/auth/context");
  return { ...actual, requireAuthContext: vi.fn(), requireTenant: vi.fn() };
});

vi.mock("@/lib/domain/capability/skillListing", () => ({
  listActiveSkills: vi.fn(),
}));

const { AuthContextError, requireAuthContext, requireTenant } = await import("@/lib/auth/context");
const { listActiveSkills } = await import("@/lib/domain/capability/skillListing");
const { GET } = await import("./route");

const requireAuthContextMock = vi.mocked(requireAuthContext);
const requireTenantMock = vi.mocked(requireTenant);
const listMock = vi.mocked(listActiveSkills);
const req = () => new Request("http://localhost/api/skills");

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
