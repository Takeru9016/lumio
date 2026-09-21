import { removeCourseFromLearningPath } from "@/lib/domain/learning-path/paths";
import { pathErrorResponse, resolvePathAdmin } from "@/lib/learning-path-api";

/**
 * Removes one course and renumbers the rest. `courseId` is the course's id (not its
 * slug). A course that is not in this path is 404, whether or not it exists.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ pathId: string; courseId: string }> }
) {
  try {
    const ctx = await resolvePathAdmin();
    const { pathId, courseId } = await params;
    const path = await removeCourseFromLearningPath(ctx, pathId, courseId);
    return Response.json({ path });
  } catch (err) {
    return pathErrorResponse(
      err,
      "Failed to remove course",
      "Couldn't remove that course from the path"
    );
  }
}
