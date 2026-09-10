import type { AuthContext } from "@/lib/auth/context";

/**
 * Which product surface initiated an AI invocation — for policy and
 * observability, not hardcoded behavior everywhere (docs/V2_AI_ARCHITECTURE.md,
 * "AI capability classes"). SEARCH/COURSE_CREATOR/COPILOT are not wired to a
 * route yet this phase (only TUTOR is — src/app/api/ai/tutor/route.ts); they
 * exist so policy.ts/provider.ts have a real shape to extend into rather than
 * being TUTOR-only.
 */
export type AISurface = "TUTOR" | "SEARCH" | "COURSE_CREATOR" | "COPILOT";

/**
 * Action classification, not a permission framework. READ/GENERATE are
 * supported this phase; WRITE/EXECUTE are defined here so the runtime's
 * shape is right, but policy.ts denies both for every surface — see
 * docs/V2_AI_ARCHITECTURE.md, "AI capability classes" for the READ/GENERATE/
 * WRITE/EXECUTE definitions this maps to.
 */
export type AIAction = "READ" | "GENERATE" | "WRITE" | "EXECUTE";

/**
 * Every AI runtime call carries this. `auth.tenantId` may be null (a
 * FREE-plan user has no tenant) — callers must check before anything
 * tenant-scoped (Knowledge retrieval, V2 persistence) runs; the runtime
 * never falls back to a global/unscoped mode on its own.
 */
export type AIRequestContext = {
  auth: AuthContext;
  surface: AISurface;
  conversationId?: string;
  courseId?: string;
  lessonId?: string;
};

export type AIRuntimeErrorCategory =
  | "AUTH"
  | "POLICY_DENIED"
  | "KNOWLEDGE_RETRIEVAL"
  | "PROVIDER"
  | "PERSISTENCE"
  | "QUOTA_RATE_LIMIT";

/**
 * Typed error category for the runtime's internal stages (see
 * docs/V2_AI_ARCHITECTURE.md, "Error handling" for which categories fail the
 * request vs. degrade gracefully). Callers should catch this specifically
 * before falling back to a generic 500 — never forward `.message` verbatim
 * to the client for AUTH/POLICY_DENIED (see routes for how this is used).
 */
export class AIRuntimeError extends Error {
  constructor(
    public category: AIRuntimeErrorCategory,
    message: string,
    public cause?: unknown
  ) {
    super(message);
    this.name = "AIRuntimeError";
  }
}
