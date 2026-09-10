import { Prisma } from "@/generated/prisma/client";
import { generateEmbedding, toVectorLiteral } from "@/lib/ai/embeddings";
import { db } from "@/lib/db";
import { getUserTeamIds, type KnowledgeAccessContext } from "@/lib/domain/knowledge/access";

export type KnowledgeSearchResult = {
  chunkId: string;
  documentId: string;
  sourceId: string;
  content: string;
  score: number;
  metadata: unknown;
  citation: { documentTitle: string; sourceId: string };
};

export type KnowledgeSearchOptions = {
  sourceId?: string;
  documentId?: string;
  topK?: number;
  minSimilarity?: number;
};

const DEFAULT_TOP_K = 5;
const DEFAULT_MIN_SIMILARITY = 0.5;

type Row = {
  chunkId: string;
  documentId: string;
  sourceId: string;
  content: string;
  similarity: number;
  metadata: unknown;
  documentTitle: string;
};

/**
 * Permission-aware semantic search over the Knowledge layer.
 *
 * Unlike src/lib/ai/search.ts (searchSimilarLessons — trusts an optional
 * courseId and otherwise searches every published lesson with no tenant
 * filter at all, because Lesson has no tenantId), every clause of
 * authorization here is inlined directly into the SQL WHERE, in the SAME
 * query that ranks and limits results. This is deliberate: fetching
 * candidate chunks first and filtering permissions in application code would
 * let an unauthorized chunk influence ranking/limit before being dropped, or
 * leak through a debug log of "raw" candidates — the exact failure mode
 * Phase 2E's spec calls out. There is no code path in this function that
 * returns a chunk before the authorization predicate has been evaluated by
 * Postgres itself.
 *
 * The `context` parameter is required and typed as KnowledgeAccessContext
 * (tenantId non-nullable) — there is no overload or fallback that accepts a
 * bare tenantId string, so a caller cannot search by trusting a
 * caller-supplied tenant id instead of the authenticated session's.
 */
export async function searchKnowledge(
  context: KnowledgeAccessContext,
  query: string,
  options: KnowledgeSearchOptions = {}
): Promise<KnowledgeSearchResult[]> {
  const topK = options.topK ?? DEFAULT_TOP_K;
  const minSimilarity = options.minSimilarity ?? DEFAULT_MIN_SIMILARITY;

  const embedding = await generateEmbedding(query);
  const vector = toVectorLiteral(embedding);
  const userTeamIds = await getUserTeamIds(context);

  const sourceFilter = options.sourceId
    ? Prisma.sql`AND d."sourceId" = ${options.sourceId}`
    : Prisma.empty;
  const documentFilter = options.documentId
    ? Prisma.sql`AND d.id = ${options.documentId}`
    : Prisma.empty;
  // Prisma.sql can't parametrize an array into IN (...) portably across
  // drivers, so build it as a literal list of already-validated cuids
  // (userTeamIds came from our own TeamMember query above, never from the
  // caller) — no injection surface.
  const teamIdList =
    userTeamIds.length > 0
      ? Prisma.sql`ARRAY[${Prisma.join(userTeamIds)}]::text[]`
      : Prisma.sql`ARRAY[]::text[]`;

  const rows = await db.$queryRaw<Row[]>`
    SELECT
      c.id AS "chunkId",
      c."documentId" AS "documentId",
      d."sourceId" AS "sourceId",
      c.content AS "content",
      1 - (c.embedding <=> ${vector}::vector) AS "similarity",
      c.metadata AS "metadata",
      d.title AS "documentTitle"
    FROM "KnowledgeChunk" c
    JOIN "KnowledgeDocument" d ON d.id = c."documentId"
    WHERE c.embedding IS NOT NULL
      AND c."version" = d."activeVersion"
      AND d."tenantId" = ${context.tenantId}
      AND d.status = 'READY'
      AND (
        d.visibility = 'TENANT'
        OR EXISTS (
          SELECT 1 FROM "KnowledgeAccess" ka
          WHERE ka."documentId" = d.id
            AND (
              ka.scope = 'TENANT'
              OR (ka.scope = 'TEAM' AND ka."teamId" = ANY(${teamIdList}))
              OR (ka.scope = 'USER' AND ka."userId" = ${context.userId})
            )
        )
      )
      AND (1 - (c.embedding <=> ${vector}::vector)) >= ${minSimilarity}
      ${sourceFilter}
      ${documentFilter}
    ORDER BY c.embedding <=> ${vector}::vector ASC, c.id ASC
    LIMIT ${topK}
  `;

  return rows.map((row) => ({
    chunkId: row.chunkId,
    documentId: row.documentId,
    sourceId: row.sourceId,
    content: row.content,
    score: row.similarity,
    metadata: row.metadata,
    citation: { documentTitle: row.documentTitle, sourceId: row.sourceId },
  }));
}
