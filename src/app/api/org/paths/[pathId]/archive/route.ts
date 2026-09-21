import { archiveLearningPath } from "@/lib/domain/learning-path/paths";
import { pathErrorResponse, readEmptyBody, resolvePathAdmin } from "@/lib/learning-path-api";

/**
 * Archives a draft or published path (Phase 29.3.2). The body is empty. Nothing of
 * the path is deleted: its courses, order and history stay, and it can be published
 * again. An already archived path is 409 INVALID_TRANSITION.
 */
export async function POST(req: Request, { params }: { params: Promise<{ pathId: string }> }) {
  try {
    const ctx = await resolvePathAdmin();
    await readEmptyBody(req);
    const { pathId } = await params;
    return Response.json({ path: await archiveLearningPath(ctx, pathId) });
  } catch (err) {
    return pathErrorResponse(err, "Failed to archive path", "Couldn't archive that learning path");
  }
}
