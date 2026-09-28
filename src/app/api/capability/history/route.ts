import { AuthContextError, requireAuthContext, requireTenant } from "@/lib/auth/context";
import type { HistoryEventType } from "@/lib/domain/capability/history";
import { getLearnerHistory, HistoryCursorError, MAX_LIMIT } from "@/lib/domain/capability/history";

const EVENT_TYPES: HistoryEventType[] = ["PROFICIENCY_CHANGED", "EVIDENCE_STANDING_CHANGED"];

/** Accepts only YYYY-MM-DD (read as UTC midnight) or a full ISO timestamp
 * with an explicit Z/offset — never a bare local-time string (discovery §15,
 * "never use server-local time"). Returns "invalid" for anything else. */
function parseDate(raw: string | null): Date | undefined | "invalid" {
  if (raw === null) return undefined;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const fullIso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(raw);
  if (!dateOnly && !fullIso) return "invalid";
  const d = new Date(dateOnly ? `${raw}T00:00:00.000Z` : raw);
  return Number.isNaN(d.getTime()) ? "invalid" : d;
}

/**
 * Phase 30.4 — the learner's own capability history (docs/PHASE_30.4_DISCOVERY.md
 * §4/§16). Strictly self-scoped: no userId/tenantId is ever read from the
 * query string, only from the authenticated AuthContext.
 */
export async function GET(req: Request) {
  let ctx: Awaited<ReturnType<typeof requireAuthContext>>;
  try {
    ctx = await requireAuthContext();
    requireTenant(ctx);
  } catch (err) {
    if (err instanceof AuthContextError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  const { searchParams } = new URL(req.url);
  const cursor = searchParams.get("cursor") ?? undefined;
  const skillId = searchParams.get("skillId") ?? undefined;

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
    const page = await getLearnerHistory(ctx, { skillId, type, from, to }, { cursor, limit });
    return Response.json(page);
  } catch (err) {
    if (err instanceof HistoryCursorError) {
      return Response.json({ error: "Invalid cursor" }, { status: 400 });
    }
    console.error("[capability/history] Failed to load learner history", err);
    return Response.json({ error: "Failed to load history" }, { status: 500 });
  }
}
