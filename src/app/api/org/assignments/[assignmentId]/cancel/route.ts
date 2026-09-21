import { requireAuthContext } from "@/lib/auth/context";
import { authorizeActor, cancelAssignment } from "@/lib/domain/learning-assignment/assignments";
import { cancelFailureResponse, errorResponse } from "@/lib/learning-assignment-api";

/**
 * Organisation admin: cancel one learning assignment (Phase 28.5).
 *
 * The domain does the work: it scopes the assignment to the admin's tenant,
 * refuses a completed one, serialises against course completion, and records the
 * cancellation history. Cancelling keeps the learner's enrollment, progress and
 * evidence, and is safe to repeat (`already_cancelled`).
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ assignmentId: string }> }
) {
  try {
    const ctx = await requireAuthContext();
    authorizeActor(ctx);

    const { assignmentId } = await params;
    const result = await cancelAssignment(ctx, assignmentId);
    if (!result.ok) return cancelFailureResponse(result.reason);

    return Response.json({ outcome: result.outcome });
  } catch (err) {
    return errorResponse(
      err,
      "Failed to cancel assignment",
      "Couldn't cancel that assignment. Please try again."
    );
  }
}
