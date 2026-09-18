import {
  AuthContextError,
  requireAuthContext,
  requireRole,
  requireTenant,
} from "@/lib/auth/context";
import {
  getInstructorCapabilityForLearnerRole,
  getInstructorLearnerRoles,
} from "@/lib/domain/capability/instructorReport";

type Params = { params: Promise<{ learnerId: string }> };

/**
 * Phase 21 — INSTRUCTOR-only role switcher for a single learner's row on
 * /instructor/capability. `roleId` is optional: omitted, defaults to that
 * learner's primary role (falling back to whichever role sorts first if
 * they somehow have none marked primary — see getInstructorLearnerRoles's
 * ordering); supplied, it's validated against that learner's own
 * UserJobRole rows before anything is computed for it (never a bare
 * client-supplied roleId passed through unchecked). Authorization is
 * enforced entirely inside getInstructorLearnerRoles/
 * getInstructorCapabilityForLearnerRole (instructor must own an Enrollment
 * for this learner) — this route adds no separate ownership check of its
 * own, so there is exactly one place that boundary lives.
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
  const requestedRoleId = new URL(req.url).searchParams.get("roleId") ?? undefined;

  const roles = await getInstructorLearnerRoles(ctx.userId, ctx.tenantId, learnerId);
  if (!roles) {
    return Response.json({ error: "Learner not found" }, { status: 404 });
  }

  const roleId =
    requestedRoleId && roles.some((r) => r.roleId === requestedRoleId)
      ? requestedRoleId
      : (roles.find((r) => r.isPrimary)?.roleId ?? roles[0]?.roleId);

  if (!roleId) {
    return Response.json({ roles, learner: null });
  }

  const learner = await getInstructorCapabilityForLearnerRole(
    ctx.userId,
    ctx.tenantId,
    learnerId,
    roleId
  );
  return Response.json({ roles, learner });
}
