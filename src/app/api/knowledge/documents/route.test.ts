import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/context", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/context")>("@/lib/auth/context");
  return { ...actual, requireAuthContext: vi.fn(), requireTenant: vi.fn(), requireRole: vi.fn() };
});

vi.mock("@/lib/domain/knowledge/listing", () => ({
  listReadableKnowledgeDocuments: vi.fn(),
}));

vi.mock("@/lib/domain/knowledge/management", () => ({
  findOrCreateCreatorSource: vi.fn(),
  grantOwnerAccess: vi.fn(),
}));

vi.mock("@/lib/domain/knowledge/ingestion", () => ({
  createTextDocument: vi.fn(),
  indexDocument: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { knowledgeDocument: { findUniqueOrThrow: vi.fn() } },
}));

const { AuthContextError, requireAuthContext, requireTenant, requireRole } = await import(
  "@/lib/auth/context"
);
const { listReadableKnowledgeDocuments } = await import("@/lib/domain/knowledge/listing");
const { findOrCreateCreatorSource, grantOwnerAccess } = await import(
  "@/lib/domain/knowledge/management"
);
const { createTextDocument, indexDocument } = await import("@/lib/domain/knowledge/ingestion");
const { db } = await import("@/lib/db");
const { GET, POST } = await import("./route");

const requireAuthContextMock = vi.mocked(requireAuthContext);
const requireTenantMock = vi.mocked(requireTenant);
const requireRoleMock = vi.mocked(requireRole);
const listMock = vi.mocked(listReadableKnowledgeDocuments);
const findOrCreateCreatorSourceMock = vi.mocked(findOrCreateCreatorSource);
const grantOwnerAccessMock = vi.mocked(grantOwnerAccess);
const createTextDocumentMock = vi.mocked(createTextDocument);
const indexDocumentMock = vi.mocked(indexDocument);
const findUniqueOrThrowMock = vi.mocked(db.knowledgeDocument.findUniqueOrThrow);
const req = () => new Request("http://localhost/api/knowledge/documents");
const postReq = (body: unknown) =>
  new Request("http://localhost/api/knowledge/documents", {
    method: "POST",
    body: JSON.stringify(body),
  });

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

describe("POST /api/knowledge/documents", () => {
  const ctx = { userId: "u1", clerkId: "c1", tenantId: "t1", role: "INSTRUCTOR" as const };

  it("unauthenticated -> 401", async () => {
    requireAuthContextMock.mockRejectedValue(new AuthContextError(401, "Unauthorized"));

    const res = await POST(postReq({ title: "t", textContent: "c" }));

    expect(res.status).toBe(401);
  });

  it("authenticated without a tenant -> 400", async () => {
    requireAuthContextMock.mockResolvedValue({ ...ctx, tenantId: null });
    requireTenantMock.mockImplementation(() => {
      throw new AuthContextError(400, "No organisation found");
    });

    const res = await POST(postReq({ title: "t", textContent: "c" }));

    expect(res.status).toBe(400);
  });

  it("STUDENT -> 403", async () => {
    requireAuthContextMock.mockResolvedValue({ ...ctx, role: "STUDENT" });
    requireTenantMock.mockImplementation(() => {});
    requireRoleMock.mockImplementation(() => {
      throw new AuthContextError(403, "Forbidden");
    });

    const res = await POST(postReq({ title: "t", textContent: "c" }));

    expect(res.status).toBe(403);
  });

  it("SUPER_ADMIN -> 403, no shortcut", async () => {
    requireAuthContextMock.mockResolvedValue({ ...ctx, role: "SUPER_ADMIN" });
    requireTenantMock.mockImplementation(() => {});
    requireRoleMock.mockImplementation(() => {
      throw new AuthContextError(403, "Forbidden");
    });

    const res = await POST(postReq({ title: "t", textContent: "c" }));

    expect(res.status).toBe(403);
  });

  it("empty title -> 400", async () => {
    requireAuthContextMock.mockResolvedValue(ctx);
    requireTenantMock.mockImplementation(() => {});
    requireRoleMock.mockImplementation(() => {});

    const res = await POST(postReq({ title: "", textContent: "c" }));

    expect(res.status).toBe(400);
  });

  it("empty textContent -> 400", async () => {
    requireAuthContextMock.mockResolvedValue(ctx);
    requireTenantMock.mockImplementation(() => {});
    requireRoleMock.mockImplementation(() => {});

    const res = await POST(postReq({ title: "t", textContent: "" }));

    expect(res.status).toBe(400);
  });

  it("textContent over 50,000 chars -> 400", async () => {
    requireAuthContextMock.mockResolvedValue(ctx);
    requireTenantMock.mockImplementation(() => {});
    requireRoleMock.mockImplementation(() => {});

    const res = await POST(postReq({ title: "t", textContent: "x".repeat(50_001) }));

    expect(res.status).toBe(400);
  });

  it("invalid visibility -> 400", async () => {
    requireAuthContextMock.mockResolvedValue(ctx);
    requireTenantMock.mockImplementation(() => {});
    requireRoleMock.mockImplementation(() => {});

    const res = await POST(postReq({ title: "t", textContent: "c", visibility: "PUBLIC" }));

    expect(res.status).toBe(400);
  });

  it("unknown field -> 400 (strict schema)", async () => {
    requireAuthContextMock.mockResolvedValue(ctx);
    requireTenantMock.mockImplementation(() => {});
    requireRoleMock.mockImplementation(() => {});

    const res = await POST(postReq({ title: "t", textContent: "c", extra: "nope" }));

    expect(res.status).toBe(400);
    expect(findOrCreateCreatorSourceMock).not.toHaveBeenCalled();
  });

  it("client-supplied tenantId is rejected -> 400, never reaches domain layer", async () => {
    requireAuthContextMock.mockResolvedValue(ctx);
    requireTenantMock.mockImplementation(() => {});
    requireRoleMock.mockImplementation(() => {});

    const res = await POST(postReq({ title: "t", textContent: "c", tenantId: "t2" }));

    expect(res.status).toBe(400);
    expect(createTextDocumentMock).not.toHaveBeenCalled();
  });

  it("client-supplied userId is rejected -> 400", async () => {
    requireAuthContextMock.mockResolvedValue(ctx);
    requireTenantMock.mockImplementation(() => {});
    requireRoleMock.mockImplementation(() => {});

    const res = await POST(postReq({ title: "t", textContent: "c", userId: "someone-else" }));

    expect(res.status).toBe(400);
  });

  it("client-supplied createdByUserId/createdByRole/sourceId are rejected -> 400", async () => {
    requireAuthContextMock.mockResolvedValue(ctx);
    requireTenantMock.mockImplementation(() => {});
    requireRoleMock.mockImplementation(() => {});

    const res = await POST(
      postReq({
        title: "t",
        textContent: "c",
        createdByUserId: "someone-else",
        createdByRole: "ORG_ADMIN",
        sourceId: "s-other",
      })
    );

    expect(res.status).toBe(400);
  });

  it("successful creation + indexing -> 200, status READY, metadata is server-derived", async () => {
    requireAuthContextMock.mockResolvedValue(ctx);
    requireTenantMock.mockImplementation(() => {});
    requireRoleMock.mockImplementation(() => {});
    findOrCreateCreatorSourceMock.mockResolvedValue({ id: "src-1" } as never);
    createTextDocumentMock.mockResolvedValue({ id: "doc-1", visibility: "TENANT" } as never);
    indexDocumentMock.mockResolvedValue({ documentId: "doc-1", version: 1, chunkCount: 2 });
    findUniqueOrThrowMock.mockResolvedValue({
      id: "doc-1",
      title: "t",
      status: "READY",
      visibility: "TENANT",
      createdAt: new Date("2026-01-01"),
    } as never);

    const res = await POST(postReq({ title: "t", textContent: "c" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.document.status).toBe("READY");
    expect(createTextDocumentMock).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        sourceId: "src-1",
        title: "t",
        textContent: "c",
        visibility: "TENANT",
        metadata: { createdByUserId: "u1", createdByRole: "INSTRUCTOR" },
      })
    );
    expect(grantOwnerAccessMock).not.toHaveBeenCalled();
  });

  it("RESTRICTED visibility grants the creator their own access row", async () => {
    requireAuthContextMock.mockResolvedValue(ctx);
    requireTenantMock.mockImplementation(() => {});
    requireRoleMock.mockImplementation(() => {});
    findOrCreateCreatorSourceMock.mockResolvedValue({ id: "src-1" } as never);
    createTextDocumentMock.mockResolvedValue({ id: "doc-1", visibility: "RESTRICTED" } as never);
    indexDocumentMock.mockResolvedValue({ documentId: "doc-1", version: 1, chunkCount: 1 });
    findUniqueOrThrowMock.mockResolvedValue({
      id: "doc-1",
      title: "t",
      status: "READY",
      visibility: "RESTRICTED",
      createdAt: new Date(),
    } as never);

    await POST(postReq({ title: "t", textContent: "c", visibility: "RESTRICTED" }));

    expect(grantOwnerAccessMock).toHaveBeenCalledWith(ctx, "doc-1");
  });

  it("indexing failure -> 200, status ERROR, not a 500, not a fake READY", async () => {
    requireAuthContextMock.mockResolvedValue(ctx);
    requireTenantMock.mockImplementation(() => {});
    requireRoleMock.mockImplementation(() => {});
    findOrCreateCreatorSourceMock.mockResolvedValue({ id: "src-1" } as never);
    createTextDocumentMock.mockResolvedValue({ id: "doc-1", visibility: "TENANT" } as never);
    indexDocumentMock.mockRejectedValue(new Error("embedding provider down"));
    findUniqueOrThrowMock.mockResolvedValue({
      id: "doc-1",
      title: "t",
      status: "ERROR",
      visibility: "TENANT",
      createdAt: new Date(),
    } as never);

    const res = await POST(postReq({ title: "t", textContent: "c" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.document.status).toBe("ERROR");
  });
});
