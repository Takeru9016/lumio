import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/context", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/context")>("@/lib/auth/context");
  return { ...actual, requireAuthContext: vi.fn(), requireTenant: vi.fn(), requireRole: vi.fn() };
});

vi.mock("@/lib/domain/knowledge/management", () => ({
  findOrCreateCreatorSource: vi.fn(),
  grantOwnerAccess: vi.fn(),
}));

vi.mock("@/lib/domain/knowledge/ingestion", () => ({
  createTextDocument: vi.fn(),
  indexDocument: vi.fn(),
}));

vi.mock("@/lib/domain/knowledge/fileExtraction", async () => {
  const actual = await vi.importActual<typeof import("@/lib/domain/knowledge/fileExtraction")>(
    "@/lib/domain/knowledge/fileExtraction"
  );
  return { ...actual, extractKnowledgeText: vi.fn() };
});

vi.mock("@/lib/db", () => ({
  db: { knowledgeDocument: { findUniqueOrThrow: vi.fn() } },
}));

const { AuthContextError, requireAuthContext, requireTenant, requireRole } = await import(
  "@/lib/auth/context"
);
const { findOrCreateCreatorSource, grantOwnerAccess } = await import(
  "@/lib/domain/knowledge/management"
);
const { createTextDocument, indexDocument } = await import("@/lib/domain/knowledge/ingestion");
const { extractKnowledgeText, FileExtractionError } = await import(
  "@/lib/domain/knowledge/fileExtraction"
);
const { db } = await import("@/lib/db");
const { POST } = await import("./route");

const requireAuthContextMock = vi.mocked(requireAuthContext);
const requireTenantMock = vi.mocked(requireTenant);
const requireRoleMock = vi.mocked(requireRole);
const findOrCreateCreatorSourceMock = vi.mocked(findOrCreateCreatorSource);
const grantOwnerAccessMock = vi.mocked(grantOwnerAccess);
const createTextDocumentMock = vi.mocked(createTextDocument);
const indexDocumentMock = vi.mocked(indexDocument);
const extractKnowledgeTextMock = vi.mocked(extractKnowledgeText);
const findUniqueOrThrowMock = vi.mocked(db.knowledgeDocument.findUniqueOrThrow);

const ALLOWED_URL = "https://abc123.ufs.sh/f/somekey";

function req(body: unknown) {
  return new Request("http://localhost/api/knowledge/documents/upload", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function validBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    title: "My PDF",
    file: { url: ALLOWED_URL, name: "policy.pdf", size: 1000 },
    ...overrides,
  };
}

function mockAuthOk(role: "INSTRUCTOR" | "ORG_ADMIN" = "INSTRUCTOR") {
  requireAuthContextMock.mockResolvedValue({
    userId: "user-1",
    clerkId: "clerk-1",
    tenantId: "tenant-1",
    role,
  } as never);
  requireTenantMock.mockImplementation(() => undefined as never);
  requireRoleMock.mockImplementation(() => undefined as never);
}

function mockFetchOnce(init: {
  status?: number;
  headers?: Record<string, string>;
  body?: Uint8Array | null;
  redirected?: boolean;
}) {
  const status = init.status ?? 200;
  const bodyBytes = init.body ?? new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (bodyBytes.byteLength > 0) controller.enqueue(bodyBytes);
      controller.close();
    },
  });
  global.fetch = vi.fn().mockResolvedValue(
    new Response(status >= 300 && status < 400 ? null : stream, {
      status,
      headers: init.headers,
    })
  ) as never;
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("POST /api/knowledge/documents/upload — auth", () => {
  it("unauthenticated -> 401", async () => {
    requireAuthContextMock.mockRejectedValue(new AuthContextError(401, "Unauthorized"));
    const res = await POST(req(validBody()));
    expect(res.status).toBe(401);
  });

  it("missing tenant -> 400", async () => {
    requireAuthContextMock.mockResolvedValue({
      userId: "u1",
      clerkId: "c1",
      tenantId: null,
      role: "INSTRUCTOR",
    } as never);
    requireTenantMock.mockImplementation(() => {
      throw new AuthContextError(400, "Tenant required");
    });
    const res = await POST(req(validBody()));
    expect(res.status).toBe(400);
  });

  it("STUDENT -> 403", async () => {
    mockAuthOk();
    requireRoleMock.mockImplementation(() => {
      throw new AuthContextError(403, "Forbidden");
    });
    const res = await POST(req(validBody()));
    expect(res.status).toBe(403);
  });

  it("SUPER_ADMIN -> 403 (no shortcut into Knowledge management)", async () => {
    mockAuthOk();
    requireRoleMock.mockImplementation(() => {
      throw new AuthContextError(403, "Forbidden");
    });
    const res = await POST(req(validBody()));
    expect(res.status).toBe(403);
    expect(requireRoleMock).toHaveBeenCalledWith(expect.anything(), ["INSTRUCTOR", "ORG_ADMIN"]);
  });
});

describe("POST /api/knowledge/documents/upload — request validation", () => {
  it("malformed JSON -> 400", async () => {
    mockAuthOk();
    const res = await POST(
      new Request("http://localhost/api/knowledge/documents/upload", {
        method: "POST",
        body: "not json",
      })
    );
    expect(res.status).toBe(400);
  });

  it("missing title -> 400", async () => {
    mockAuthOk();
    const res = await POST(req(validBody({ title: undefined })));
    expect(res.status).toBe(400);
  });

  it("invalid visibility -> 400", async () => {
    mockAuthOk();
    const res = await POST(req(validBody({ visibility: "PUBLIC" })));
    expect(res.status).toBe(400);
  });

  it("missing file -> 400", async () => {
    mockAuthOk();
    const res = await POST(req({ title: "x" }));
    expect(res.status).toBe(400);
  });

  it("rejects an unrecognized client identity field (strict schema)", async () => {
    mockAuthOk();
    const res = await POST(req(validBody({ tenantId: "other-tenant" })));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/knowledge/documents/upload — SSRF / URL security", () => {
  it("invalid URL -> 400", async () => {
    mockAuthOk();
    const res = await POST(req(validBody({ file: { url: "not a url", name: "a.pdf", size: 10 } })));
    expect(res.status).toBe(400);
  });

  it("HTTP (non-HTTPS) URL rejected", async () => {
    mockAuthOk();
    const res = await POST(
      req(validBody({ file: { url: "http://abc123.ufs.sh/f/x", name: "a.pdf", size: 10 } }))
    );
    expect(res.status).toBe(400);
  });

  it("non-Uploadthing host rejected", async () => {
    mockAuthOk();
    const res = await POST(
      req(validBody({ file: { url: "https://evil.example.com/f/x", name: "a.pdf", size: 10 } }))
    );
    expect(res.status).toBe(400);
  });

  it("lookalike host (ufs.sh as a suffix of an attacker domain) rejected", async () => {
    mockAuthOk();
    const res = await POST(
      req(
        validBody({
          file: { url: "https://notufs.sh.evil.com/f/x", name: "a.pdf", size: 10 },
        })
      )
    );
    expect(res.status).toBe(400);
  });

  it("localhost rejected", async () => {
    mockAuthOk();
    const res = await POST(
      req(validBody({ file: { url: "https://localhost/f/x", name: "a.pdf", size: 10 } }))
    );
    expect(res.status).toBe(400);
  });

  it("private IP literal rejected", async () => {
    mockAuthOk();
    const res = await POST(
      req(validBody({ file: { url: "https://10.0.0.5/f/x", name: "a.pdf", size: 10 } }))
    );
    expect(res.status).toBe(400);
  });

  it("does not follow a redirect from an allowed host to another host", async () => {
    mockAuthOk();
    mockFetchOnce({ status: 302, headers: { location: "https://evil.example.com/steal" } });
    const res = await POST(req(validBody()));
    expect(res.status).toBe(502);
    const fetchCall = vi.mocked(global.fetch).mock.calls[0];
    expect(fetchCall[1]).toMatchObject({ redirect: "manual" });
  });

  it("declared Content-Length over 16MB rejected before reading the body", async () => {
    mockAuthOk();
    mockFetchOnce({ headers: { "content-length": String(20 * 1024 * 1024) } });
    const res = await POST(
      req(validBody({ file: { url: ALLOWED_URL, name: "a.pdf", size: 1000 } }))
    );
    expect(res.status).toBe(413);
  });

  it("rejects when actual streamed bytes exceed 16MB even without a Content-Length header", async () => {
    mockAuthOk();
    const bigChunk = new Uint8Array(17 * 1024 * 1024);
    mockFetchOnce({ body: bigChunk });
    const res = await POST(req(validBody()));
    expect(res.status).toBe(413);
  });

  it("client-declared file.size over 16MB rejected without ever fetching", async () => {
    mockAuthOk();
    global.fetch = vi.fn();
    const res = await POST(
      req(validBody({ file: { url: ALLOWED_URL, name: "a.pdf", size: 20_000_000 } }))
    );
    expect(res.status).toBe(413);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("POST /api/knowledge/documents/upload — extraction outcomes", () => {
  it("extraction failure creates no document", async () => {
    mockAuthOk();
    mockFetchOnce({});
    extractKnowledgeTextMock.mockRejectedValue(
      new FileExtractionError("PARSE_FAILED", "Unable to parse file contents")
    );
    const res = await POST(req(validBody()));
    expect(res.status).toBe(422);
    expect(createTextDocumentMock).not.toHaveBeenCalled();
  });

  it("too-short extraction creates no document", async () => {
    mockAuthOk();
    mockFetchOnce({});
    extractKnowledgeTextMock.mockRejectedValue(
      new FileExtractionError("TOO_SHORT", "No extractable text found in this file")
    );
    const res = await POST(req(validBody()));
    expect(res.status).toBe(422);
    expect(createTextDocumentMock).not.toHaveBeenCalled();
  });

  it("too-long extraction creates no document (no truncation)", async () => {
    mockAuthOk();
    mockFetchOnce({});
    extractKnowledgeTextMock.mockRejectedValue(
      new FileExtractionError("TOO_LONG", "File content is too long")
    );
    const res = await POST(req(validBody()));
    expect(res.status).toBe(422);
    expect(createTextDocumentMock).not.toHaveBeenCalled();
  });

  it("declared .pdf extension mismatching the detected DOCX format is rejected", async () => {
    mockAuthOk();
    mockFetchOnce({});
    extractKnowledgeTextMock.mockResolvedValue({
      text: "x".repeat(60),
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    const res = await POST(req(validBody({ file: { url: ALLOWED_URL, name: "a.pdf", size: 10 } })));
    expect(res.status).toBe(422);
    expect(createTextDocumentMock).not.toHaveBeenCalled();
  });

  it("successful PDF extraction creates and indexes a document", async () => {
    mockAuthOk();
    mockFetchOnce({});
    extractKnowledgeTextMock.mockResolvedValue({
      text: "extracted pdf text ".repeat(5),
      mimeType: "application/pdf",
    });
    findOrCreateCreatorSourceMock.mockResolvedValue({ id: "source-1" } as never);
    createTextDocumentMock.mockResolvedValue({ id: "doc-1", visibility: "TENANT" } as never);
    indexDocumentMock.mockResolvedValue({ documentId: "doc-1", version: 1, chunkCount: 1 });
    findUniqueOrThrowMock.mockResolvedValue({
      id: "doc-1",
      title: "My PDF",
      status: "READY",
      visibility: "TENANT",
      createdAt: new Date(),
    } as never);

    const res = await POST(req(validBody()));
    expect(res.status).toBe(200);
    expect(createTextDocumentMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        mimeType: "application/pdf",
        metadata: expect.objectContaining({
          createdByUserId: "user-1",
          createdByRole: "INSTRUCTOR",
          file: expect.objectContaining({ provider: "uploadthing", originalName: "policy.pdf" }),
        }),
      })
    );
    expect(indexDocumentMock).toHaveBeenCalledWith(expect.anything(), "doc-1");
  });

  it("successful DOCX extraction creates and indexes a document", async () => {
    mockAuthOk();
    mockFetchOnce({});
    extractKnowledgeTextMock.mockResolvedValue({
      text: "extracted docx text ".repeat(5),
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    findOrCreateCreatorSourceMock.mockResolvedValue({ id: "source-1" } as never);
    createTextDocumentMock.mockResolvedValue({ id: "doc-2", visibility: "TENANT" } as never);
    indexDocumentMock.mockResolvedValue({ documentId: "doc-2", version: 1, chunkCount: 1 });
    findUniqueOrThrowMock.mockResolvedValue({
      id: "doc-2",
      title: "My DOCX",
      status: "READY",
      visibility: "TENANT",
      createdAt: new Date(),
    } as never);

    const res = await POST(
      req(
        validBody({ title: "My DOCX", file: { url: ALLOWED_URL, name: "policy.docx", size: 1000 } })
      )
    );
    expect(res.status).toBe(200);
  });

  it("indexing failure leaves the document in ERROR but still returns 200", async () => {
    mockAuthOk();
    mockFetchOnce({});
    extractKnowledgeTextMock.mockResolvedValue({
      text: "extracted pdf text ".repeat(5),
      mimeType: "application/pdf",
    });
    findOrCreateCreatorSourceMock.mockResolvedValue({ id: "source-1" } as never);
    createTextDocumentMock.mockResolvedValue({ id: "doc-3", visibility: "TENANT" } as never);
    indexDocumentMock.mockRejectedValue(new Error("embedding provider down"));
    findUniqueOrThrowMock.mockResolvedValue({
      id: "doc-3",
      title: "My PDF",
      status: "ERROR",
      visibility: "TENANT",
      createdAt: new Date(),
    } as never);

    const res = await POST(req(validBody()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { document: { status: string } };
    expect(body.document.status).toBe("ERROR");
  });

  it("RESTRICTED visibility grants owner access", async () => {
    mockAuthOk();
    mockFetchOnce({});
    extractKnowledgeTextMock.mockResolvedValue({
      text: "extracted pdf text ".repeat(5),
      mimeType: "application/pdf",
    });
    findOrCreateCreatorSourceMock.mockResolvedValue({ id: "source-1" } as never);
    createTextDocumentMock.mockResolvedValue({ id: "doc-4", visibility: "RESTRICTED" } as never);
    indexDocumentMock.mockResolvedValue({ documentId: "doc-4", version: 1, chunkCount: 1 });
    findUniqueOrThrowMock.mockResolvedValue({
      id: "doc-4",
      title: "My PDF",
      status: "READY",
      visibility: "RESTRICTED",
      createdAt: new Date(),
    } as never);

    const res = await POST(req(validBody({ visibility: "RESTRICTED" })));
    expect(res.status).toBe(200);
    expect(grantOwnerAccessMock).toHaveBeenCalledWith(expect.anything(), "doc-4");
  });

  it("never trusts a client-declared tenantId/userId — always uses the server-resolved context", async () => {
    mockAuthOk("ORG_ADMIN");
    mockFetchOnce({});
    extractKnowledgeTextMock.mockResolvedValue({
      text: "extracted pdf text ".repeat(5),
      mimeType: "application/pdf",
    });
    findOrCreateCreatorSourceMock.mockResolvedValue({ id: "source-1" } as never);
    createTextDocumentMock.mockResolvedValue({ id: "doc-5", visibility: "TENANT" } as never);
    indexDocumentMock.mockResolvedValue({ documentId: "doc-5", version: 1, chunkCount: 1 });
    findUniqueOrThrowMock.mockResolvedValue({
      id: "doc-5",
      title: "My PDF",
      status: "READY",
      visibility: "TENANT",
      createdAt: new Date(),
    } as never);

    await POST(req(validBody()));
    expect(createTextDocumentMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({
          createdByUserId: "user-1",
          createdByRole: "ORG_ADMIN",
        }),
      })
    );
  });
});
