import { publishLearningPath } from "@/lib/domain/learning-path/paths";
import { pathErrorResponse, readEmptyBody, resolvePathAdmin } from "@/lib/learning-path-api";

/**
 * Publishes a draft path, or republishes an archived one (Phase 29.3.2). The body
 * is empty: the status and the publication time are decided here, never sent. A
 * path whose courses are not all published and completable right now is 409
 * PATH_NOT_PUBLISHABLE, naming the courses, and is left unchanged.
 */
export async function POST(req: Request, { params }: { params: Promise<{ pathId: string }> }) {
  try {
    const ctx = await resolvePathAdmin();
    await readEmptyBody(req);
    const { pathId } = await params;
    return Response.json({ path: await publishLearningPath(ctx, pathId) });
  } catch (err) {
    return pathErrorResponse(err, "Failed to publish path", "Couldn't publish that learning path");
  }
}
