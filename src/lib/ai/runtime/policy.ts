import type { AIAction, AISurface } from "@/lib/ai/runtime/types";
import { AIRuntimeError } from "@/lib/ai/runtime/types";

/**
 * Table-driven, fail-closed AI policy (docs/V2_AI_ARCHITECTURE.md, "AI
 * capability classes"). This is deliberately not a general permission
 * framework — it answers exactly one question per (surface, action) pair,
 * with no inheritance, no roles, no per-user overrides.
 *
 * WRITE and EXECUTE are `false` for every surface, on purpose, for the
 * entire phase — see docs/V2_MIGRATION_MAP.md, "Phase 3" for why (no agent
 * execution, no generic DB write access from the AI runtime yet). Do not
 * flip these to `true` without a corresponding design review; they are not
 * simply unimplemented, they are actively disabled.
 */
const POLICY: Record<AISurface, Record<AIAction, boolean>> = {
  TUTOR: { READ: true, GENERATE: true, WRITE: false, EXECUTE: false },
  // Search only retrieves — it has no generation step of its own.
  SEARCH: { READ: true, GENERATE: false, WRITE: false, EXECUTE: false },
  COURSE_CREATOR: { READ: true, GENERATE: true, WRITE: false, EXECUTE: false },
  COPILOT: { READ: true, GENERATE: true, WRITE: false, EXECUTE: false },
};

/** Pure — no I/O. An unrecognized surface has no table entry and is denied. */
export function isActionAllowed(surface: AISurface, action: AIAction): boolean {
  return POLICY[surface]?.[action] ?? false;
}

/** Throws AIRuntimeError("POLICY_DENIED") instead of returning false — for call sites that should fail hard. */
export function assertActionAllowed(surface: AISurface, action: AIAction): void {
  if (!isActionAllowed(surface, action)) {
    throw new AIRuntimeError("POLICY_DENIED", `AI policy denied: ${surface} may not ${action}`);
  }
}
