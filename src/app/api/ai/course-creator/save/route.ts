import { z } from "zod";
import { AuthContextError, requireAuthContext } from "@/lib/auth/context";
import { CourseAuthorizationError } from "@/lib/domain/course/authorization";
import { saveCourseDraft } from "@/lib/domain/course-creator/saveDraft";

/**
 * The human/application save boundary (spec §1, §9). This route does NOT
 * call the AI runtime, does NOT check assertActionAllowed(COURSE_CREATOR,
 * WRITE) — that action is and remains denied for every surface — and does
 * NOT trust anything in the request body for identity/authorization. It
 * authenticates via Clerk/requireAuthContext exactly like every other
 * non-AI course route, and saveCourseDraft re-verifies role/plan/skill
 * ownership server-side before writing anything.
 */
export async function POST(req: Request) {
  let authCtx: Awaited<ReturnType<typeof requireAuthContext>>;
  try {
    authCtx = await requireAuthContext();
  } catch (err) {
    if (err instanceof AuthContextError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const course = await saveCourseDraft(authCtx, body);
    return Response.json(course, { status: 201 });
  } catch (err) {
    if (err instanceof AuthContextError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof CourseAuthorizationError) {
      return Response.json(
        { error: err.message, upgradeRequired: err.upgradeRequired },
        { status: err.status }
      );
    }
    if (err instanceof z.ZodError) {
      return Response.json({ error: err.flatten() }, { status: 400 });
    }
    console.error("[course-creator] save draft failed", err);
    return Response.json({ error: "Failed to save draft course" }, { status: 500 });
  }
}
