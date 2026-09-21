import { requireAuthContext } from "@/lib/auth/context";
import {
  authorizeLearner,
  listLearningPathsForLearner,
  readLearnerListQuery,
} from "@/lib/domain/learner-path/learnerPaths";
import { pathErrorResponse } from "@/lib/learning-path-api";

/**
 * The signed-in learner's organisation's published learning paths (Phase 29.3.3).
 *
 * Read-only and self-scoped: the learner and the tenant come from the session, and
 * the only query parameters are `limit` (default 50, at most 200) and `cursor`; any
 * other, a user or tenant included, is 400. Authorization (a STUDENT with a tenant)
 * runs before the query string is read. Draft and archived paths never appear.
 */
export async function GET(req: Request) {
  try {
    const ctx = await requireAuthContext();
    authorizeLearner(ctx);
    const query = readLearnerListQuery(new URL(req.url).searchParams);
    return Response.json(await listLearningPathsForLearner(ctx, query));
  } catch (err) {
    return pathErrorResponse(
      err,
      "Failed to list paths for a learner",
      "Failed to load learning paths"
    );
  }
}
