import { createLearningPath, listLearningPathsForAdmin } from "@/lib/domain/learning-path/paths";
import { pathErrorResponse, readJsonBody, resolvePathAdmin } from "@/lib/learning-path-api";

/**
 * Organisation admin: learning paths (Phase 29.3.1).
 *
 * Authorization runs first, before the query string or the body is looked at. The
 * tenant and the creator come from the session and are never read from the request;
 * a body that names them, a status, a position or anything else unknown is refused.
 */

export async function GET(req: Request) {
  try {
    const ctx = await resolvePathAdmin();
    const params = new URL(req.url).searchParams;
    const result = await listLearningPathsForAdmin(ctx, {
      status: params.get("status"),
      cursor: params.get("cursor"),
      limit: params.get("limit"),
    });
    return Response.json(result);
  } catch (err) {
    return pathErrorResponse(err, "Failed to list paths", "Failed to load learning paths");
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await resolvePathAdmin();
    const path = await createLearningPath(ctx, await readJsonBody(req));
    return Response.json({ path }, { status: 201 });
  } catch (err) {
    return pathErrorResponse(err, "Failed to create path", "Couldn't create that learning path");
  }
}
