/**
 * Fixed-size word-window chunker with overlap. Pure function, no I/O — this
 * is the "smallest sound" chunking strategy for the dev/text ingestion path
 * (Phase 2D); connector-specific chunking (PDF page boundaries, transcript
 * timestamps, etc.) is a later, per-connector concern, not built here.
 */
export type TextChunk = {
  chunkIndex: number;
  content: string;
};

const DEFAULT_CHUNK_WORDS = 220;
const DEFAULT_OVERLAP_WORDS = 40;

export function chunkText(
  text: string,
  options: { chunkWords?: number; overlapWords?: number } = {}
): TextChunk[] {
  const chunkWords = options.chunkWords ?? DEFAULT_CHUNK_WORDS;
  const overlapWords = options.overlapWords ?? DEFAULT_OVERLAP_WORDS;
  if (chunkWords <= overlapWords) {
    throw new Error("chunkWords must be greater than overlapWords");
  }

  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const chunks: TextChunk[] = [];
  const step = chunkWords - overlapWords;

  for (let start = 0, chunkIndex = 0; start < words.length; start += step, chunkIndex++) {
    const slice = words.slice(start, start + chunkWords);
    chunks.push({ chunkIndex, content: slice.join(" ") });
    if (start + chunkWords >= words.length) break;
  }

  return chunks;
}
