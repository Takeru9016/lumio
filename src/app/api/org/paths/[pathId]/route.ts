import { getLearningPathForAdmin, updateLearningPath } from "@/lib/domain/learning-path/paths";
import { pathErrorResponse, readJsonBody, resolvePathAdmin } from "@/lib/learning-path-api";

type Params = { params: Promise<{ pathId: string }> };

/** One path of the admin's own tenant in any status; anything else is one uniform 404. */
export async function GET(_req: Request, { params }: Params) {
  try {
    const ctx = await resolvePathAdmin();
    const { pathId } = await params;
    return Response.json({ path: await getLearningPathForAdmin(ctx, pathId) });
  } catch (err) {
    return pathErrorResponse(err, "Failed to load path", "Failed to load that learning path");
  }
}

/** Title and description only. An archived path is read-only (409). */
export async function PATCH(req: Request, { params }: Params) {
  try {
    const ctx = await resolvePathAdmin();
    const { pathId } = await params;
    const path = await updateLearningPath(ctx, pathId, await readJsonBody(req));
    return Response.json({ path });
  } catch (err) {
    return pathErrorResponse(err, "Failed to update path", "Couldn't update that learning path");
  }
}
