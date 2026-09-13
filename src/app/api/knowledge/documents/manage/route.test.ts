import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/context", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/context")>("@/lib/auth/context");
  return { ...actual, requireAuthContext: vi.fn(), requireTenant: vi.fn(), requireRole: vi.fn() };
});

vi.mock("@/lib/domain/knowledge/management", () => ({
  listManageableKnowledgeDocuments: vi.fn(),
}));

const { AuthContextError, requireAuthContext, requireTenant, requireRole } = await import(
  "@/lib/auth/context"
);
const { listManageableKnowledgeDocuments } = await import("@/lib/domain/knowledge/management");
const { GET } = await import("./route");

const requireAuthContextMock = vi.mocked(requireAuthContext);
const requireTenantMock = vi.mocked(requireTenant);
const requireRoleMock = vi.mocked(requireRole);
const listMock = vi.mocked(listManageableKnowledgeDocuments);
const req = () => new Request("http://localhost/api/knowledge/documents/manage");

afterEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/knowledge/documents/manage", () => {
  it("unauthenticated -> 401", async () => {
    requireAuthContextMock.mockRejectedValue(new AuthContextError(401, "Unauthorized"));

    const res = await GET(req());

    expect(res.status).toBe(401);
  });

  it("authenticated without a tenant -> 400", async () => {
    requireAuthContextMock.mockResolvedValue({
      userId: "u1",
      clerkId: "c1",
      tenantId: null,
      role: "INSTRUCTOR",
    });
    requireTenantMock.mockImplementation(() => {
      throw new AuthContextError(400, "No organisation found");
    });

    const res = await GET(req());

    expect(res.status).toBe(400);
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

  it("INSTRUCTOR -> 200 with the domain layer's result, untouched", async () => {
    requireAuthContextMock.mockResolvedValue({
      userId: "u1",
      clerkId: "c1",
      tenantId: "t1",
      role: "INSTRUCTOR",
    });
    requireTenantMock.mockImplementation(() => {});
    requireRoleMock.mockImplementation(() => {});
    listMock.mockResolvedValue([
      {
        id: "d1",
        title: "Doc",
        status: "READY",
        visibility: "TENANT",
        createdAt: new Date("2026-01-01"),
        sourceType: "DOCUMENT",
        createdByUserId: null,
        createdByName: null,
      },
    ]);

    const res = await GET(req());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.documents).toHaveLength(1);
    expect(body.documents[0].id).toBe("d1");
  });

  it("ORG_ADMIN -> 200", async () => {
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
  });

  it("unexpected error -> 500, no internal detail leaked", async () => {
    requireAuthContextMock.mockResolvedValue({
      userId: "u1",
      clerkId: "c1",
      tenantId: "t1",
      role: "INSTRUCTOR",
    });
    requireTenantMock.mockImplementation(() => {});
    requireRoleMock.mockImplementation(() => {});
    listMock.mockRejectedValue(new Error("db exploded"));

    const res = await GET(req());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to load documents" });
  });
});
