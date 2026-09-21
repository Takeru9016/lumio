import { addCourseToLearningPath } from "@/lib/domain/learning-path/paths";
import { pathErrorResponse, readJsonBody, resolvePathAdmin } from "@/lib/learning-path-api";

/** Adds one course, at the end. The body is `{ courseId }`; a position is never accepted. */
export async function POST(req: Request, { params }: { params: Promise<{ pathId: string }> }) {
  try {
    const ctx = await resolvePathAdmin();
    const { pathId } = await params;
    const path = await addCourseToLearningPath(ctx, pathId, await readJsonBody(req));
    return Response.json({ path }, { status: 201 });
  } catch (err) {
    return pathErrorResponse(err, "Failed to add course", "Couldn't add that course to the path");
  }
}
