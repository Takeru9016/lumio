import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/context", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/context")>("@/lib/auth/context");
  return { ...actual, requireAuthContext: vi.fn(), requireTenant: vi.fn() };
});

vi.mock("@/lib/domain/knowledge/listing", () => ({
  listReadableKnowledgeDocuments: vi.fn(),
}));

const { AuthContextError, requireAuthContext, requireTenant } = await import("@/lib/auth/context");
const { listReadableKnowledgeDocuments } = await import("@/lib/domain/knowledge/listing");
const { GET } = await import("./route");

const requireAuthContextMock = vi.mocked(requireAuthContext);
const requireTenantMock = vi.mocked(requireTenant);
const listMock = vi.mocked(listReadableKnowledgeDocuments);
const req = () => new Request("http://localhost/api/knowledge/documents");

afterEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/knowledge/documents", () => {
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
      { id: "d1", title: "Doc 1", sourceId: "s1", sourceName: "Source 1" },
    ]);

    const res = await GET(req());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      documents: [{ id: "d1", title: "Doc 1", sourceId: "s1", sourceName: "Source 1" }],
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
    expect(await res.json()).toEqual({ documents: [] });
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
    expect(await res.json()).toEqual({ error: "Failed to list documents" });
  });
});
