import type { KnowledgeChunk, KnowledgeDocument, KnowledgeSource } from "@/generated/prisma/client";

/**
 * Type-only foundation for the knowledge domain (Source -> Document -> Chunk
 * — see docs/V2_DOMAIN_MODEL.md, "Knowledge"). Retrieval still runs on the
 * legacy `Lesson.embedding` path (src/lib/ai/search.ts) until V2 knowledge
 * retrieval replaces it (docs/V2_AI_ARCHITECTURE.md, "Retrieval") — no
 * service layer here yet.
 */
export type { KnowledgeSource, KnowledgeDocument, KnowledgeChunk };

export type KnowledgeDocumentWithSource = KnowledgeDocument & { source: KnowledgeSource };
export type KnowledgeChunkWithDocument = KnowledgeChunk & { document: KnowledgeDocument };
