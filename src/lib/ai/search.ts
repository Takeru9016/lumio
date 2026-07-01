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
 * distance (`<=>`). Optionally scopes to a single course. Only published,
 * non-archived, already-embedded lessons with embeddable content (READY video
 * or non-null textContent) are considered — students never receive draft or
 * archived content as RAG context.
 *
 * @param query   natural-language search text
 * @param courseId optional — restrict results to lessons in this course
 * @param limit   max results (default 3)
 */
export async function searchSimilarLessons(
  query: string,
  courseId?: string,
  limit = 3,
): Promise<SimilarLesson[]> {
  const embedding = await generateEmbedding(query);
  const vector = toVectorLiteral(embedding);

  const courseFilter = courseId
    ? Prisma.sql`AND "sectionId" IN (SELECT id FROM "Section" WHERE "courseId" = ${courseId})`
    : Prisma.empty;

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
