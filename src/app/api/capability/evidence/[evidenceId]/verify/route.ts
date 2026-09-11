import { z } from "zod";
import { AuthContextError, requireAuthContext, requireTenant } from "@/lib/auth/context";
import {
  CapabilityVerificationError,
  rejectEvidence,
  verifyEvidence,
} from "@/lib/domain/capability/verification";

const bodySchema = z.object({
  action: z.enum(["verify", "reject"]),
});

/**
 * The only capability-verification endpoint (Phase 5 MVP) — deliberately
 * two fixed actions, never a request to set a proficiency directly. See
 * src/lib/domain/capability/verification.ts for the authorization predicate
 * and the fact that the resulting UserSkill state is always derived, never
 * accepted from this request body.
 */
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
    const userSkill =
      parsed.data.action === "verify"
        ? await verifyEvidence(ctx, evidenceId)
        : await rejectEvidence(ctx, evidenceId);
    return Response.json({ userSkill });
  } catch (err) {
    if (err instanceof CapabilityVerificationError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error(`[capability] Failed to ${parsed.data.action} evidence ${evidenceId}`, err);
    return Response.json({ error: "Failed to update evidence" }, { status: 500 });
  }
}
