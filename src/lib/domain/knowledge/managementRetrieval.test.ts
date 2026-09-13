import { afterAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { createTenantUser, fakeEmbedding } from "@/lib/domain/knowledge/__test__/fixtures";

/**
 * Phase 14 integration boundary (contract §12): proves a document created
 * through the NEW staff creation path (findOrCreateCreatorSource +
 * createTextDocument + indexDocument — exactly what POST
 * /api/knowledge/documents calls) becomes retrievable by the EXISTING,
 * unmodified searchKnowledge(), and that tenant isolation still holds for
 * documents created this way. Only the embedding call is mocked, to a
 * deterministic vector — the same real Postgres/pgvector authorization SQL
 * retrieval.security.test.ts already covers is exercised here again, this
 * time fed by the new creation path rather than createIndexedDocument's
 * test-only shortcut.
 */
const QUERY_VECTOR = fakeEmbedding(4242);
vi.mock("@/lib/ai/embeddings", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/embeddings")>("@/lib/ai/embeddings");
  return {
    ...actual,
    generateEmbedding: vi.fn().mockResolvedValue(QUERY_VECTOR),
  };
});

const { findOrCreateCreatorSource } = await import("@/lib/domain/knowledge/management");
const { createTextDocument, indexDocument } = await import("@/lib/domain/knowledge/ingestion");
const { searchKnowledge } = await import("@/lib/domain/knowledge/retrieval");

afterAll(async () => {
  await db.$disconnect();
});

describe("Phase 14 creation path -> existing searchKnowledge()", () => {
  it("a document created via the staff path is searchable by its own tenant", async () => {
    const { ctx } = await createTenantUser("INSTRUCTOR");
    const source = await findOrCreateCreatorSource(ctx);
    const document = await createTextDocument(ctx, {
      sourceId: source.id,
      title: "Staff-authored policy",
      textContent: "onboarding checklist content ".repeat(30),
      visibility: "TENANT",
      metadata: { createdByUserId: ctx.userId, createdByRole: ctx.role },
    });
    await indexDocument(ctx, document.id);

    const results = await searchKnowledge(ctx, "anything (mocked)");

    expect(results.some((r) => r.documentId === document.id)).toBe(true);
  });

  it("a cross-tenant context cannot retrieve it", async () => {
    const { ctx } = await createTenantUser("INSTRUCTOR");
    const { ctx: otherTenantCtx } = await createTenantUser("INSTRUCTOR");
    const source = await findOrCreateCreatorSource(ctx);
    const document = await createTextDocument(ctx, {
      sourceId: source.id,
      title: "Tenant-private doc",
      textContent: "confidential onboarding content ".repeat(30),
      visibility: "TENANT",
      metadata: { createdByUserId: ctx.userId, createdByRole: ctx.role },
    });
    await indexDocument(ctx, document.id);

    const results = await searchKnowledge(otherTenantCtx, "anything (mocked)");

    expect(results.some((r) => r.documentId === document.id)).toBe(false);
  });

  it("a document that failed indexing (status ERROR) is never retrieved", async () => {
    const { ctx } = await createTenantUser("INSTRUCTOR");
    const source = await findOrCreateCreatorSource(ctx);
    const document = await createTextDocument(ctx, {
      sourceId: source.id,
      title: "Never indexed",
      textContent: "   ",
    });
    await expect(indexDocument(ctx, document.id)).rejects.toThrow();

    const results = await searchKnowledge(ctx, "anything (mocked)");

    expect(results.some((r) => r.documentId === document.id)).toBe(false);
  });
});
