import { afterAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { readValidPdfFixture } from "@/lib/domain/knowledge/__test__/fileFixtures";
import { createTenantUser, fakeEmbedding } from "@/lib/domain/knowledge/__test__/fixtures";

/**
 * Phase 16 integration boundary (contract §22): proves a document created
 * through the NEW file-upload extraction path (extractKnowledgeText — real
 * PDF, real worker_threads, real unpdf — feeding the SAME, unmodified
 * createTextDocument()/indexDocument() Phase 14 pipeline) becomes
 * retrievable by the EXISTING, unmodified searchKnowledge() — proving Phase
 * 16 does not introduce a second retrieval/RAG path.
 */
const QUERY_VECTOR = fakeEmbedding(1616);
vi.mock("@/lib/ai/embeddings", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/embeddings")>("@/lib/ai/embeddings");
  return {
    ...actual,
    generateEmbedding: vi.fn().mockResolvedValue(QUERY_VECTOR),
  };
});

const { findOrCreateCreatorSource } = await import("@/lib/domain/knowledge/management");
const { createTextDocument, indexDocument } = await import("@/lib/domain/knowledge/ingestion");
const { extractKnowledgeText } = await import("@/lib/domain/knowledge/fileExtraction");
const { searchKnowledge } = await import("@/lib/domain/knowledge/retrieval");

afterAll(async () => {
  await db.$disconnect();
});

describe("Phase 16 file-upload extraction -> existing createTextDocument/indexDocument/searchKnowledge", () => {
  it("a document created from a real extracted PDF is retrievable by the existing, unmodified searchKnowledge()", async () => {
    const { ctx } = await createTenantUser("INSTRUCTOR");
    const source = await findOrCreateCreatorSource(ctx);

    const extraction = await extractKnowledgeText(readValidPdfFixture());

    const document = await createTextDocument(ctx, {
      sourceId: source.id,
      title: "Uploaded policy PDF",
      textContent: extraction.text,
      mimeType: extraction.mimeType,
      visibility: "TENANT",
      metadata: { createdByUserId: ctx.userId, createdByRole: ctx.role },
    });
    await indexDocument(ctx, document.id);

    const results = await searchKnowledge(ctx, "fifty character minimum");
    expect(results.some((r) => r.documentId === document.id)).toBe(true);

    const stored = await db.knowledgeDocument.findUniqueOrThrow({ where: { id: document.id } });
    expect(stored.mimeType).toBe("application/pdf");
    expect(stored.status).toBe("READY");
  });

  it("tenant isolation still holds for a document created via the file-upload path", async () => {
    const { ctx: ownerCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: otherTenantCtx } = await createTenantUser("INSTRUCTOR");

    const source = await findOrCreateCreatorSource(ownerCtx);
    const extraction = await extractKnowledgeText(readValidPdfFixture());
    const document = await createTextDocument(ownerCtx, {
      sourceId: source.id,
      title: "Tenant-scoped upload",
      textContent: extraction.text,
      mimeType: extraction.mimeType,
      visibility: "TENANT",
      metadata: { createdByUserId: ownerCtx.userId, createdByRole: ownerCtx.role },
    });
    await indexDocument(ownerCtx, document.id);

    const results = await searchKnowledge(otherTenantCtx, "fifty character minimum");
    expect(results.some((r) => r.documentId === document.id)).toBe(false);
  });
});
