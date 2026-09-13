import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/context", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/context")>("@/lib/auth/context");
  return { ...actual, requireAuthContext: vi.fn(), requireTenant: vi.fn(), requireRole: vi.fn() };
});

vi.mock("@/lib/domain/knowledge/management", () => ({
  canManageKnowledgeDocument: vi.fn(),
}));

vi.mock("@/lib/domain/knowledge/ingestion", () => ({
  indexDocument: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    knowledgeDocument: {
      findFirst: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

const { AuthContextError, requireAuthContext, requireTenant, requireRole } = await import(
  "@/lib/auth/context"
);
const { canManageKnowledgeDocument } = await import("@/lib/domain/knowledge/management");
const { indexDocument } = await import("@/lib/domain/knowledge/ingestion");
const { db } = await import("@/lib/db");
const { PATCH, DELETE } = await import("./route");

const requireAuthContextMock = vi.mocked(requireAuthContext);
const requireTenantMock = vi.mocked(requireTenant);
const requireRoleMock = vi.mocked(requireRole);
const canManageMock = vi.mocked(canManageKnowledgeDocument);
const indexDocumentMock = vi.mocked(indexDocument);
const findFirstMock = vi.mocked(db.knowledgeDocument.findFirst);
const findUniqueOrThrowMock = vi.mocked(db.knowledgeDocument.findUniqueOrThrow);
const deleteMock = vi.mocked(db.knowledgeDocument.delete);

const ctx = { userId: "instructor-1", clerkId: "c1", tenantId: "t1", role: "INSTRUCTOR" as const };
const params = (id = "doc-1") => ({ params: Promise.resolve({ id }) });
const patchReq = (body: unknown = { action: "reindex" }) =>
  new Request("http://localhost/api/knowledge/documents/doc-1", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
const deleteReq = () =>
  new Request("http://localhost/api/knowledge/documents/doc-1", { method: "DELETE" });

afterEach(() => {
  vi.resetAllMocks();
});

describe("PATCH /api/knowledge/documents/[id]", () => {
  it("unauthenticated -> 401", async () => {
    requireAuthContextMock.mockRejectedValue(new AuthContextError(401, "Unauthorized"));

    const res = await PATCH(patchReq(), params());

    expect(res.status).toBe(401);
  });

  it("missing tenant -> 400", async () => {
    requireAuthContextMock.mockResolvedValue({ ...ctx, tenantId: null });
    requireTenantMock.mockImplementation(() => {
      throw new AuthContextError(400, "No organisation found");
    });

    const res = await PATCH(patchReq(), params());

    expect(res.status).toBe(400);
  });

  it("STUDENT -> 403", async () => {
    requireAuthContextMock.mockResolvedValue({ ...ctx, role: "STUDENT" });
    requireTenantMock.mockImplementation(() => {});
    requireRoleMock.mockImplementation(() => {
      throw new AuthContextError(403, "Forbidden");
    });

    const res = await PATCH(patchReq(), params());

    expect(res.status).toBe(403);
  });

  it("SUPER_ADMIN -> 403, no shortcut", async () => {
    requireAuthContextMock.mockResolvedValue({ ...ctx, role: "SUPER_ADMIN" });
    requireTenantMock.mockImplementation(() => {});
    requireRoleMock.mockImplementation(() => {
      throw new AuthContextError(403, "Forbidden");
    });

    const res = await PATCH(patchReq(), params());

    expect(res.status).toBe(403);
  });

  it("invalid body -> 400", async () => {
    requireAuthContextMock.mockResolvedValue(ctx);
    requireTenantMock.mockImplementation(() => {});
    requireRoleMock.mockImplementation(() => {});

    const res = await PATCH(patchReq({ action: "edit" }), params());

    expect(res.status).toBe(400);
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it("cross-tenant/nonexistent document id -> 404, looked up scoped to {id, tenantId}", async () => {
    requireAuthContextMock.mockResolvedValue(ctx);
    requireTenantMock.mockImplementation(() => {});
    requireRoleMock.mockImplementation(() => {});
    findFirstMock.mockResolvedValue(null);

    const res = await PATCH(patchReq(), params("doc-elsewhere"));

    expect(res.status).toBe(404);
    expect(findFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "doc-elsewhere", tenantId: "t1" } })
    );
  });

  it("in-tenant document owned by another instructor -> 403", async () => {
    requireAuthContextMock.mockResolvedValue(ctx);
    requireTenantMock.mockImplementation(() => {});
    requireRoleMock.mockImplementation(() => {});
    findFirstMock.mockResolvedValue({
      id: "doc-1",
      tenantId: "t1",
      metadata: { createdByUserId: "instructor-2" },
    } as never);
    canManageMock.mockReturnValue(false);

    const res = await PATCH(patchReq(), params());

    expect(res.status).toBe(403);
    expect(indexDocumentMock).not.toHaveBeenCalled();
  });

  it("instructor reindexing their own document -> 200, calls indexDocument", async () => {
    requireAuthContextMock.mockResolvedValue(ctx);
    requireTenantMock.mockImplementation(() => {});
    requireRoleMock.mockImplementation(() => {});
    findFirstMock.mockResolvedValue({
      id: "doc-1",
      tenantId: "t1",
      metadata: { createdByUserId: "instructor-1" },
    } as never);
    canManageMock.mockReturnValue(true);
    indexDocumentMock.mockResolvedValue({ documentId: "doc-1", version: 2, chunkCount: 3 });
    findUniqueOrThrowMock.mockResolvedValue({
      id: "doc-1",
      title: "t",
      status: "READY",
      visibility: "TENANT",
      createdAt: new Date(),
    } as never);

    const res = await PATCH(patchReq(), params());

    expect(res.status).toBe(200);
    expect(indexDocumentMock).toHaveBeenCalledWith(ctx, "doc-1");
  });

  it("ORG_ADMIN reindexing any in-tenant document -> 200", async () => {
    const adminCtx = { ...ctx, userId: "admin-1", role: "ORG_ADMIN" as const };
    requireAuthContextMock.mockResolvedValue(adminCtx);
    requireTenantMock.mockImplementation(() => {});
    requireRoleMock.mockImplementation(() => {});
    findFirstMock.mockResolvedValue({
      id: "doc-1",
      tenantId: "t1",
      metadata: { createdByUserId: "instructor-1" },
    } as never);
    canManageMock.mockReturnValue(true);
    indexDocumentMock.mockResolvedValue({ documentId: "doc-1", version: 2, chunkCount: 3 });
    findUniqueOrThrowMock.mockResolvedValue({
      id: "doc-1",
      title: "t",
      status: "READY",
      visibility: "TENANT",
      createdAt: new Date(),
    } as never);

    const res = await PATCH(patchReq(), params());

    expect(res.status).toBe(200);
  });

  it("reindex still returns the ERROR status when indexing fails again", async () => {
    requireAuthContextMock.mockResolvedValue(ctx);
    requireTenantMock.mockImplementation(() => {});
    requireRoleMock.mockImplementation(() => {});
    findFirstMock.mockResolvedValue({
      id: "doc-1",
      tenantId: "t1",
      metadata: { createdByUserId: "instructor-1" },
    } as never);
    canManageMock.mockReturnValue(true);
    indexDocumentMock.mockRejectedValue(new Error("still down"));
    findUniqueOrThrowMock.mockResolvedValue({
      id: "doc-1",
      title: "t",
      status: "ERROR",
      visibility: "TENANT",
      createdAt: new Date(),
    } as never);

    const res = await PATCH(patchReq(), params());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.document.status).toBe("ERROR");
  });
});

describe("DELETE /api/knowledge/documents/[id]", () => {
  it("unauthenticated -> 401", async () => {
    requireAuthContextMock.mockRejectedValue(new AuthContextError(401, "Unauthorized"));

    const res = await DELETE(deleteReq(), params());

    expect(res.status).toBe(401);
  });

  it("SUPER_ADMIN -> 403, no shortcut", async () => {
    requireAuthContextMock.mockResolvedValue({ ...ctx, role: "SUPER_ADMIN" });
    requireTenantMock.mockImplementation(() => {});
    requireRoleMock.mockImplementation(() => {
      throw new AuthContextError(403, "Forbidden");
    });

    const res = await DELETE(deleteReq(), params());

    expect(res.status).toBe(403);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("cross-tenant document -> 404", async () => {
    requireAuthContextMock.mockResolvedValue(ctx);
    requireTenantMock.mockImplementation(() => {});
    requireRoleMock.mockImplementation(() => {});
    findFirstMock.mockResolvedValue(null);

    const res = await DELETE(deleteReq(), params());

    expect(res.status).toBe(404);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("instructor attempts an ORG_ADMIN-created document -> 403", async () => {
    requireAuthContextMock.mockResolvedValue(ctx);
    requireTenantMock.mockImplementation(() => {});
    requireRoleMock.mockImplementation(() => {});
    findFirstMock.mockResolvedValue({
      id: "doc-1",
      tenantId: "t1",
      metadata: { createdByUserId: "admin-1", createdByRole: "ORG_ADMIN" },
    } as never);
    canManageMock.mockReturnValue(false);

    const res = await DELETE(deleteReq(), params());

    expect(res.status).toBe(403);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("owning instructor deletes their own document -> 200, hard delete", async () => {
    requireAuthContextMock.mockResolvedValue(ctx);
    requireTenantMock.mockImplementation(() => {});
    requireRoleMock.mockImplementation(() => {});
    findFirstMock.mockResolvedValue({
      id: "doc-1",
      tenantId: "t1",
      metadata: { createdByUserId: "instructor-1" },
    } as never);
    canManageMock.mockReturnValue(true);
    deleteMock.mockResolvedValue({} as never);

    const res = await DELETE(deleteReq(), params());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(deleteMock).toHaveBeenCalledWith({ where: { id: "doc-1" } });
  });

  it("ORG_ADMIN deletes any in-tenant document, including their own -> 200", async () => {
    const adminCtx = { ...ctx, userId: "admin-1", role: "ORG_ADMIN" as const };
    requireAuthContextMock.mockResolvedValue(adminCtx);
    requireTenantMock.mockImplementation(() => {});
    requireRoleMock.mockImplementation(() => {});
    findFirstMock.mockResolvedValue({
      id: "doc-1",
      tenantId: "t1",
      metadata: { createdByUserId: "admin-1" },
    } as never);
    canManageMock.mockReturnValue(true);
    deleteMock.mockResolvedValue({} as never);

    const res = await DELETE(deleteReq(), params());

    expect(res.status).toBe(200);
  });
});
