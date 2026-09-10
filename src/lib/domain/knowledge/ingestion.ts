import type { Prisma } from "@/generated/prisma/client";
import type { KnowledgeSourceType, KnowledgeVisibility } from "@/generated/prisma/enums";
import { EMBEDDING_MODEL, generateEmbedding, toVectorLiteral } from "@/lib/ai/embeddings";
import { db } from "@/lib/db";
import { assertSameTenant, type KnowledgeAccessContext } from "@/lib/domain/knowledge/access";
import { chunkText } from "@/lib/domain/knowledge/chunking";

export type CreateSourceInput = {
  type: KnowledgeSourceType;
  name: string;
  description?: string;
  externalId?: string;
  metadata?: Record<string, unknown>;
};

export async function createKnowledgeSource(ctx: KnowledgeAccessContext, input: CreateSourceInput) {
  return db.knowledgeSource.create({
    data: {
      tenantId: ctx.tenantId,
      type: input.type,
      name: input.name,
      description: input.description,
      externalId: input.externalId,
      metadata: input.metadata as Prisma.InputJsonValue | undefined,
    },
  });
}

export type CreateTextDocumentInput = {
  sourceId: string;
  title: string;
  textContent: string;
  mimeType?: string;
  url?: string;
  visibility?: KnowledgeVisibility;
  metadata?: Record<string, unknown>;
};

/**
 * Creates a KnowledgeDocument in PENDING status — call indexDocument()
 * separately to chunk/embed it. Kept as two steps (not one) so a future
 * connector can create many documents up front and index them on its own
 * schedule/queue.
 */
export async function createTextDocument(
  ctx: KnowledgeAccessContext,
  input: CreateTextDocumentInput
) {
  const source = await db.knowledgeSource.findUnique({ where: { id: input.sourceId } });
  if (!source) throw new Error(`KnowledgeSource ${input.sourceId} not found`);
  assertSameTenant(ctx.tenantId, [{ tenantId: source.tenantId, label: "KnowledgeSource" }]);

  return db.knowledgeDocument.create({
    data: {
      tenantId: ctx.tenantId,
      sourceId: source.id,
      title: input.title,
      textContent: input.textContent,
      mimeType: input.mimeType,
      url: input.url,
      visibility: input.visibility ?? "TENANT",
      metadata: input.metadata as Prisma.InputJsonValue | undefined,
      status: "PENDING",
    },
  });
}

export type IndexDocumentResult = {
  documentId: string;
  version: number;
  chunkCount: number;
};

/**
 * Chunks + embeds a document's textContent and atomically publishes it as
 * the new active version (see KnowledgeChunk.version / KnowledgeDocument.
 * activeVersion doc comments in prisma/schema.prisma for why this is safe
 * against interruption). Text-only ingestion path (Phase 2D) — file/URL
 * connectors that need parsing are a later extension of this same boundary.
 */
export async function indexDocument(
  ctx: KnowledgeAccessContext,
  documentId: string,
  options: { chunkWords?: number; overlapWords?: number } = {}
): Promise<IndexDocumentResult> {
  const document = await db.knowledgeDocument.findUnique({ where: { id: documentId } });
  if (!document) throw new Error(`KnowledgeDocument ${documentId} not found`);
  assertSameTenant(ctx.tenantId, [{ tenantId: document.tenantId, label: "KnowledgeDocument" }]);

  if (!document.textContent?.trim()) {
    throw new Error(`KnowledgeDocument ${documentId} has no textContent to index`);
  }

  await db.knowledgeDocument.update({
    where: { id: documentId },
    data: { status: "PROCESSING" },
  });

  const nextVersion = document.activeVersion + 1;
  const textChunks = chunkText(document.textContent, options);

  try {
    for (const chunk of textChunks) {
      const embedding = await generateEmbedding(chunk.content);
      const vector = toVectorLiteral(embedding);

      // Two-step create-then-raw-UPDATE, matching embedLessonById's existing
      // pattern in src/lib/ai/embeddings.ts — Prisma can't write an
      // Unsupported("vector") column directly via `create`.
      const row = await db.knowledgeChunk.create({
        data: {
          tenantId: ctx.tenantId,
          documentId,
          content: chunk.content,
          chunkIndex: chunk.chunkIndex,
          tokenCount: null,
          version: nextVersion,
          metadata: { embeddingModel: EMBEDDING_MODEL, embeddingProvider: "openai" },
        },
      });

      await db.$executeRaw`
        UPDATE "KnowledgeChunk" SET embedding = ${vector}::vector WHERE id = ${row.id}
      `;
    }

    // Atomic publish: only after every chunk of this run is persisted does
    // retrieval start reading them (activeVersion flips in one update).
    await db.knowledgeDocument.update({
      where: { id: documentId },
      data: { activeVersion: nextVersion, status: "READY" },
    });

    return { documentId, version: nextVersion, chunkCount: textChunks.length };
  } catch (error) {
    await db.knowledgeDocument.update({
      where: { id: documentId },
      data: { status: "ERROR" },
    });
    throw error;
  }
}
