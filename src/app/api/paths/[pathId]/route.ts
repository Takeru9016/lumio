import { requireAuthContext } from "@/lib/auth/context";
import {
  authorizeLearner,
  getLearningPathForLearner,
} from "@/lib/domain/learner-path/learnerPaths";
import { pathErrorResponse } from "@/lib/learning-path-api";

/**
 * One published learning path of the signed-in learner's organisation, with each
 * course's availability for them (Phase 29.3.3). Read-only and self-scoped. A path
 * of another tenant, a draft, an archived path, an unknown id and a malformed id are
 * one and the same 404. Nothing in the URL beyond the path id is consulted.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ pathId: string }> }) {
  try {
    const ctx = await requireAuthContext();
    authorizeLearner(ctx);
    const { pathId } = await params;
    return Response.json({ path: await getLearningPathForLearner(ctx, pathId) });
  } catch (err) {
    return pathErrorResponse(
      err,
      "Failed to load a path for a learner",
      "Failed to load that learning path"
    );
  }
}
