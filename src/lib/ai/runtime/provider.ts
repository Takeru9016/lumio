import { openai } from "@/lib/ai/openai";
import type { AISurface } from "@/lib/ai/runtime/types";

export type ModelSelection = {
  model: ReturnType<typeof openai>;
  provider: "openai";
  modelId: string;
};

/**
 * Centralizes model selection so it isn't scattered per-route (previously
 * each /api/ai/* route hardcoded its own `openai("gpt-5.4...")` call — see
 * src/lib/ai/openai.ts's comment listing which model each feature used).
 * OpenAI remains the only provider; this is not a multi-provider
 * abstraction, just one seam.
 */
export function modelFor(surface: AISurface): ModelSelection {
  switch (surface) {
    case "TUTOR":
      // Streaming chat — cost-efficient model, matches the pre-runtime tutor route.
      return { model: openai("gpt-5.4-mini"), provider: "openai", modelId: "gpt-5.4-mini" };
    case "COURSE_CREATOR":
      // Not wired to a route yet — complex reasoning model, matching quiz/learning-path's choice.
      return { model: openai("gpt-5.4"), provider: "openai", modelId: "gpt-5.4" };
    case "SEARCH":
    case "COPILOT":
      // Not wired to a route yet — default to the cheaper model until a real surface says otherwise.
      return { model: openai("gpt-5.4-mini"), provider: "openai", modelId: "gpt-5.4-mini" };
  }
}
