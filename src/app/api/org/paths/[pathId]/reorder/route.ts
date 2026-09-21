import { reorderLearningPath } from "@/lib/domain/learning-path/paths";
import { pathErrorResponse, readJsonBody, resolvePathAdmin } from "@/lib/learning-path-api";

/**
 * Reorders the path. The body is `{ courseIds }`: every course of the path, in the
 * wanted order. The server assigns the positions; a stale or partial list is 409.
 */
export async function POST(req: Request, { params }: { params: Promise<{ pathId: string }> }) {
  try {
    const ctx = await resolvePathAdmin();
    const { pathId } = await params;
    const path = await reorderLearningPath(ctx, pathId, await readJsonBody(req));
    return Response.json({ path });
  } catch (err) {
    return pathErrorResponse(err, "Failed to reorder path", "Couldn't reorder that learning path");
  }
}
