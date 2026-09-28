import {
  AuthContextError,
  requireAuthContext,
  requireRole,
  requireTenant,
} from "@/lib/auth/context";
import type { HistoryEventType } from "@/lib/domain/capability/history";
import {
  getInstructorLearnerHistory,
  HistoryCursorError,
  MAX_LIMIT,
} from "@/lib/domain/capability/history";

const EVENT_TYPES: HistoryEventType[] = ["PROFICIENCY_CHANGED", "EVIDENCE_STANDING_CHANGED"];

function parseDate(raw: string | null): Date | undefined | "invalid" {
  if (raw === null) return undefined;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const fullIso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(raw);
  if (!dateOnly && !fullIso) return "invalid";
  const d = new Date(dateOnly ? `${raw}T00:00:00.000Z` : raw);
  return Number.isNaN(d.getTime()) ? "invalid" : d;
}

type Params = { params: Promise<{ learnerId: string }> };

/**
 * Phase 30.4 — instructor's owned-evidence-scoped history for one learner
 * (docs/PHASE_30.4_DISCOVERY.md §7/§16). Ownership, tenant match, and the
 * soft-deleted-learner exclusion all live inside getInstructorLearnerHistory
 * (one place the boundary lives, matching /[learnerId]'s existing
 * convention) — this route adds no separate authorization check of its own.
 * A null result (not authorized, not found, soft-deleted, foreign tenant)
 * always maps to the same 404, never a distinguishable status.
 */
export async function GET(req: Request, { params }: Params) {
  let ctx: Awaited<ReturnType<typeof requireAuthContext>>;
  try {
    ctx = await requireAuthContext();
    requireTenant(ctx);
    requireRole(ctx, ["INSTRUCTOR"]);
  } catch (err) {
    if (err instanceof AuthContextError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  const { learnerId } = await params;
  const { searchParams } = new URL(req.url);
  const cursor = searchParams.get("cursor") ?? undefined;
  const skillId = searchParams.get("skillId") ?? undefined;
  const evidenceId = searchParams.get("evidenceId") ?? undefined;

  const typeParam = searchParams.get("type");
  if (typeParam !== null && !EVENT_TYPES.includes(typeParam as HistoryEventType)) {
    return Response.json({ error: "Invalid type" }, { status: 400 });
  }
  const type = (typeParam as HistoryEventType | null) ?? undefined;

  const from = parseDate(searchParams.get("from"));
  if (from === "invalid") return Response.json({ error: "Invalid from date" }, { status: 400 });
  const to = parseDate(searchParams.get("to"));
  if (to === "invalid") return Response.json({ error: "Invalid to date" }, { status: 400 });

  const limitParam = searchParams.get("limit");
  let limit: number | undefined;
  if (limitParam !== null) {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
      return Response.json({ error: "Invalid limit" }, { status: 400 });
    }
    limit = parsed;
  }

  try {
    const page = await getInstructorLearnerHistory(
      ctx,
      learnerId,
      { skillId, type, from, to, evidenceId },
      { cursor, limit }
    );
    if (!page) return Response.json({ error: "Learner not found" }, { status: 404 });
    return Response.json(page);
  } catch (err) {
    if (err instanceof HistoryCursorError) {
      return Response.json({ error: "Invalid cursor" }, { status: 400 });
    }
    console.error("[instructor/capability/history] Failed to load learner history", err);
    return Response.json({ error: "Failed to load history" }, { status: 500 });
  }
}
