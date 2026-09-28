import { z } from "zod";
import { AuthContextError, requireAuthContext, requireTenant } from "@/lib/auth/context";
import {
  CapabilityVerificationError,
  reinstateEvidence,
  rejectEvidence,
  reopenEvidence,
  revokeEvidence,
  unverifyEvidence,
  verifyEvidence,
} from "@/lib/domain/capability/verification";

/**
 * Phase 30.3 — the action enum grows from `verify`/`reject` to the full
 * evidence-standing transition set (docs/PHASE_30.3_DISCOVERY.md §15/§28,
 * contract §Q's "Amends L"). `revoke`/`reinstate` additionally require a
 * `reason`; the other four actions keep exactly their existing shape — a
 * `z.discriminatedUnion` rather than one flat optional `reason` field, so
 * an existing client sending only `{action: "verify"}` or `{action:
 * "reject"}` is unaffected (Zod's enum/union additivity — confirmed
 * unchanged this session against `EvidenceReviewList.tsx`, the one client
 * hard-coding the `"verify" | "reject"` union).
 *
 * Every actor/tenant/ownership/revision check happens inside
 * `verification.ts`'s locked transaction — this route trusts nothing from
 * the request body except which action was requested and, for
 * revoke/reinstate, the reason text. `actorId`/`verifiedById` are never
 * accepted from the client; they are always the authenticated `ctx.userId`.
 */
const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["verify", "reject", "unverify", "reopen"]) }),
  z.object({
    action: z.enum(["revoke", "reinstate"]),
    reason: z.string().trim().min(1, "A reason is required").max(500),
  }),
]);

export async function POST(req: Request, { params }: { params: Promise<{ evidenceId: string }> }) {
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

  const { evidenceId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    let userSkill: Awaited<ReturnType<typeof verifyEvidence>>;
    switch (parsed.data.action) {
      case "verify":
        userSkill = await verifyEvidence(ctx, evidenceId);
        break;
      case "reject":
        userSkill = await rejectEvidence(ctx, evidenceId);
        break;
      case "unverify":
        userSkill = await unverifyEvidence(ctx, evidenceId);
        break;
      case "reopen":
        userSkill = await reopenEvidence(ctx, evidenceId);
        break;
      case "revoke":
        userSkill = await revokeEvidence(ctx, evidenceId, parsed.data.reason);
        break;
      case "reinstate":
        userSkill = await reinstateEvidence(ctx, evidenceId, parsed.data.reason);
        break;
    }
    return Response.json({ userSkill });
  } catch (err) {
    if (err instanceof CapabilityVerificationError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error(`[capability] Failed to ${parsed.data.action} evidence ${evidenceId}`, err);
    return Response.json({ error: "Failed to update evidence" }, { status: 500 });
  }
}
