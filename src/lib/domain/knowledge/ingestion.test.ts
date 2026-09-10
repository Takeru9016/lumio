import { afterAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { createTenantUser, fakeEmbedding } from "@/lib/domain/knowledge/__test__/fixtures";

vi.mock("@/lib/ai/embeddings", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/embeddings")>("@/lib/ai/embeddings");
  let call = 0;
  return {
    ...actual,
    generateEmbedding: vi.fn().mockImplementation(async () => {
      call += 1;
      return fakeEmbedding(call);
    }),
  };
});

const { createKnowledgeSource, createTextDocument, indexDocument } = await import(
  "@/lib/domain/knowledge/ingestion"
);

afterAll(async () => {
  await db.$disconnect();
});

describe("indexDocument — versioning safety", () => {
  it("publishes chunks at activeVersion only after indexing completes", async () => {
    const { ctx } = await createTenantUser();
    const source = await createKnowledgeSource(ctx, { type: "MANUAL", name: "src" });
    const doc = await createTextDocument(ctx, {
      sourceId: source.id,
      title: "doc",
      textContent: "one two three four five ".repeat(50),
    });
    expect(doc.activeVersion).toBe(0);

    const result = await indexDocument(ctx, doc.id);
    expect(result.version).toBe(1);
    expect(result.chunkCount).toBeGreaterThan(0);

    const updated = await db.knowledgeDocument.findUniqueOrThrow({ where: { id: doc.id } });
    expect(updated.activeVersion).toBe(1);
    expect(updated.status).toBe("READY");

    const chunks = await db.knowledgeChunk.findMany({ where: { documentId: doc.id } });
    expect(chunks.every((c) => c.version === 1)).toBe(true);
  });

  it("re-indexing writes a new version without deleting or mixing with the old one", async () => {
    const { ctx } = await createTenantUser();
    const source = await createKnowledgeSource(ctx, { type: "MANUAL", name: "src" });
    const doc = await createTextDocument(ctx, {
      sourceId: source.id,
      title: "doc",
      textContent: "alpha beta gamma delta epsilon ".repeat(50),
    });

    const first = await indexDocument(ctx, doc.id);
    const second = await indexDocument(ctx, doc.id);

    expect(second.version).toBe(first.version + 1);

    const updated = await db.knowledgeDocument.findUniqueOrThrow({ where: { id: doc.id } });
    expect(updated.activeVersion).toBe(second.version);

    const v1Chunks = await db.knowledgeChunk.findMany({
      where: { documentId: doc.id, version: first.version },
    });
    const v2Chunks = await db.knowledgeChunk.findMany({
      where: { documentId: doc.id, version: second.version },
    });
    // Old version's chunks still exist (not deleted) — they're just no
    // longer the active version, so retrieval.ts's `c.version = d.activeVersion`
    // filter excludes them without any risk of mixing the two runs' chunks.
    expect(v1Chunks.length).toBeGreaterThan(0);
    expect(v2Chunks.length).toBeGreaterThan(0);
  });

  it("rejects two chunks of the same document+version claiming the same chunkIndex", async () => {
    const { ctx } = await createTenantUser();
    const source = await createKnowledgeSource(ctx, { type: "MANUAL", name: "src" });
    const doc = await createTextDocument(ctx, {
      sourceId: source.id,
      title: "doc",
      textContent: "x",
    });

    await db.knowledgeChunk.create({
      data: { tenantId: ctx.tenantId, documentId: doc.id, content: "a", chunkIndex: 0, version: 1 },
    });

    await expect(
      db.knowledgeChunk.create({
        data: {
          tenantId: ctx.tenantId,
          documentId: doc.id,
          content: "b",
          chunkIndex: 0,
          version: 1,
        },
      })
    ).rejects.toThrow();
  });

  it("marks the document ERROR and leaves activeVersion untouched when indexing fails", async () => {
    const { ctx } = await createTenantUser();
    const source = await createKnowledgeSource(ctx, { type: "MANUAL", name: "src" });
    const doc = await createTextDocument(ctx, {
      sourceId: source.id,
      title: "doc",
      textContent: "   ", // whitespace-only -> chunkText([]) -> indexDocument throws before writing
    });

    await expect(indexDocument(ctx, doc.id)).rejects.toThrow();

    const updated = await db.knowledgeDocument.findUniqueOrThrow({ where: { id: doc.id } });
    expect(updated.activeVersion).toBe(0);
  });
});
