import type {
  KnowledgeAccess,
  KnowledgeChunk,
  KnowledgeDocument,
  KnowledgeSource,
} from "@/generated/prisma/client";

/**
 * Type-only foundation for the knowledge domain (Source -> Document -> Chunk
 * — see docs/V2_DOMAIN_MODEL.md, "Knowledge"). As of Phase 2 there IS a
 * service layer — see access.ts (authorization), ingestion.ts (write path),
 * retrieval.ts (permission-aware search) in this directory. Legacy
 * `Lesson.embedding`/`src/lib/ai/search.ts` retrieval still runs unchanged
 * alongside this (see lessonBridge.ts for the coexistence plan).
 */
export type { KnowledgeSource, KnowledgeDocument, KnowledgeChunk, KnowledgeAccess };

export type KnowledgeDocumentWithSource = KnowledgeDocument & { source: KnowledgeSource };
export type KnowledgeChunkWithDocument = KnowledgeChunk & { document: KnowledgeDocument };
