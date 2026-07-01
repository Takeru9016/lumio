import { embed } from "ai";
import { openai } from "@/lib/ai/openai";
import { db } from "@/lib/db";

const EMBEDDING_MODEL = "text-embedding-3-small";
const MAX_INPUT_CHARS = 8000;

/**
 * Generates a 1536-dim embedding for the given text via text-embedding-3-small.
 * Input longer than 8000 chars is truncated to stay within the model limit.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const input = text.slice(0, MAX_INPUT_CHARS);

  const { embedding } = await embed({
    model: openai.embedding(EMBEDDING_MODEL),
    value: input,
  });

  return embedding;
}

/**
 * Formats a number[] into the pgvector literal string `[0.1,0.2,...]`.
 * Use when binding an embedding into raw SQL as `${vec}::vector`.
 */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

/**
 * Builds the text corpus embedded for a lesson: title, description, and body.
 * Returns null when there is nothing meaningful to embed.
 */
function buildLessonCorpus(lesson: {
  title: string;
  description: string | null;
  textContent: string | null;
}): string | null {
  const parts = [lesson.title, lesson.description, lesson.textContent]
    .map((p) => p?.trim())
    .filter((p): p is string => Boolean(p));

  if (parts.length === 0) return null;
  return parts.join("\n\n");
}

/**
 * Loads a lesson's content, generates its embedding, and stores it on the row
 * via raw SQL (the column is `Unsupported("vector(1536)")`, so Prisma can't
 * write it directly). Returns true when an embedding was written, false when
 * the lesson has no embeddable content or does not exist.
 */
export async function embedLessonById(lessonId: string): Promise<boolean> {
  const lesson = await db.lesson.findUnique({
    where: { id: lessonId },
    select: { title: true, description: true, textContent: true },
  });

  if (!lesson) return false;

  const corpus = buildLessonCorpus(lesson);
  if (!corpus) return false;

  const embedding = await generateEmbedding(corpus);
  const vector = toVectorLiteral(embedding);

  await db.$executeRaw`
    UPDATE "Lesson" SET embedding = ${vector}::vector WHERE id = ${lessonId}
  `;

  return true;
}
