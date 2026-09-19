import { Prisma } from "@/generated/prisma/client";
import { generateEmbedding, toVectorLiteral } from "@/lib/ai/embeddings";
import { db } from "@/lib/db";

export type SimilarLesson = {
  id: string;
  title: string;
  textContent: string | null;
  similarity: number;
};

/**
 * Finds the lessons most semantically similar to `query` via pgvector cosine
 * distance (`<=>`), ALWAYS scoped to a single course. Only published,
 * non-archived, already-embedded lessons with embeddable content (READY video
 * or non-null textContent) are considered — students never receive draft or
 * archived content as RAG context.
 *
 * SECURITY: `Lesson` has no tenantId, so this query has no tenant predicate
 * of its own — the course scope IS the isolation boundary. `courseId` must
 * therefore be derived server-side from an already-authorized lesson/
 * enrollment (see api/ai/tutor/route.ts), never taken from a request body,
 * and it is required: an empty scope throws instead of meaning "search every
 * lesson in the database".
 *
 * @param query    natural-language search text
 * @param courseId the server-derived course to restrict results to (required)
 * @param limit    max results (default 3)
 */
export async function searchSimilarLessons(
  query: string,
  courseId: string,
  limit = 3
): Promise<SimilarLesson[]> {
  if (!courseId) {
    throw new Error("searchSimilarLessons requires a course scope");
  }

  const embedding = await generateEmbedding(query);
  const vector = toVectorLiteral(embedding);

  const courseFilter = Prisma.sql`AND "sectionId" IN (SELECT id FROM "Section" WHERE "courseId" = ${courseId})`;

  const rows = await db.$queryRaw<SimilarLesson[]>`
    SELECT
      id,
      title,
      "textContent",
      1 - (embedding <=> ${vector}::vector) AS similarity
    FROM "Lesson"
    WHERE embedding IS NOT NULL
      AND "isPublished" = true
      AND "isArchived" = false
      AND ("videoStatus" = 'READY' OR "textContent" IS NOT NULL)
      ${courseFilter}
    ORDER BY embedding <=> ${vector}::vector
    LIMIT ${limit}
  `;

  return rows;
}
