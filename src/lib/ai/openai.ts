import { createOpenAI } from "@ai-sdk/openai";

export const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

// Models in use:
// openai("gpt-5.4")        — quiz generation, learning path (complex reasoning)
// openai("gpt-5.4-mini")   — tutor chat, lesson summary (cost-efficient streaming)
// openai("text-embedding-3-small") — embeddings for pgvector
