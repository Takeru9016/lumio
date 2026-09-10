import { completeExecution } from "@/lib/ai/runtime/persistence";

const MAX_STORED_ERROR_LENGTH = 500;

/** `AIExecution.error` is a plain String column — keep it short and never store a raw stack trace. */
export function sanitizeErrorForStorage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_STORED_ERROR_LENGTH);
}

/**
 * Ensures a started AIExecution reaches exactly one terminal state
 * (SUCCEEDED or FAILED), no matter which of several possible failure paths
 * fires first — a provider error inside streamText, a stream-conversion
 * error inside toUIMessageStream, or a synchronous throw before either of
 * those ever runs (see /api/ai/tutor/route.ts for all three call sites).
 *
 * `markFailed`/`markSucceeded` are both idempotent (checked via `finalized`)
 * so calling more than one, or more than once, is always safe — only the
 * first call does anything. A failure while persisting the terminal state
 * itself is caught and logged here, never rethrown, so it can't become an
 * unhandled rejection that obscures the original model/stream error.
 */
export function createExecutionTracker(executionId: string | undefined, startedAt: number) {
  let finalized = false;

  return {
    get finalized(): boolean {
      return finalized;
    },

    async markFailed(cause: unknown): Promise<void> {
      if (!executionId || finalized) return;
      finalized = true;
      try {
        await completeExecution(executionId, {
          status: "FAILED",
          latencyMs: Date.now() - startedAt,
          error: sanitizeErrorForStorage(cause),
        });
      } catch (persistErr) {
        console.error("[ai-runtime] Failed to mark AIExecution as FAILED", persistErr);
      }
    },

    async markSucceeded(params: { inputTokens?: number; outputTokens?: number }): Promise<void> {
      if (!executionId || finalized) return;
      finalized = true;
      await completeExecution(executionId, {
        status: "SUCCEEDED",
        latencyMs: Date.now() - startedAt,
        inputTokens: params.inputTokens,
        outputTokens: params.outputTokens,
      });
    },
  };
}
