import { requireAuthContext } from "@/lib/auth/context";
import {
  AssignmentCursorError,
  listOrgAssignments,
} from "@/lib/domain/learning-assignment/adminAssignments";
import {
  authorizeActor,
  createManualAssignment,
  type ManualAssignmentInput,
} from "@/lib/domain/learning-assignment/assignments";
import {
  errorResponse,
  parseAssignmentFilters,
  parseDueDateInput,
  skipResponse,
} from "@/lib/learning-assignment-api";

/**
 * Organisation admin: learning assignments (Phase 28.5).
 *
 * Every write goes through the assignment domain; this file only turns a request
 * into a domain call and the answer into HTTP. The tenant, the acting admin, the
 * source and the source key are never read from the request: the domain derives
 * them from the session. Authorization runs before anything in the URL or body
 * is looked at, so a caller who is not an ORG_ADMIN learns nothing about the
 * shape of the API.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function GET(req: Request) {
  try {
    const ctx = await requireAuthContext();
    authorizeActor(ctx);

    const params = new URL(req.url).searchParams;
    const parsed = parseAssignmentFilters({
      source: params.get("source"),
      status: params.get("status"),
    });
    if (!parsed.ok) {
      return Response.json({ error: "Unknown source or status filter." }, { status: 400 });
    }

    const cursor = params.get("cursor") || undefined;
    const { assignments, hasMore, nextCursor } = await listOrgAssignments(ctx, parsed.filters, {
      cursor,
    });
    return Response.json({ assignments, hasMore, nextCursor });
  } catch (err) {
    if (err instanceof AssignmentCursorError) {
      return Response.json({ error: "Invalid cursor" }, { status: 400 });
    }
    return errorResponse(err, "Failed to list assignments", "Failed to load assignments");
  }
}

/**
 * Assign a course to one learner. Only `userId`, `courseId`, `dueDate` and
 * `note` are read; anything else in the body (a tenantId, an assignedById, a
 * source, a sourceKey, a reason) is ignored. Repeating a request is idempotent:
 * 201 when a row was created, 200 for the other outcomes (`existing`,
 * `updated`, `reactivated`), which the client tells apart by `outcome`.
 */
export async function POST(req: Request) {
  try {
    const ctx = await requireAuthContext();
    authorizeActor(ctx);

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return skipResponse("INVALID_INPUT");
    }
    if (!isRecord(body)) return skipResponse("INVALID_INPUT");

    const dueDate = parseDueDateInput(body.dueDate);
    if (!dueDate.ok) return skipResponse("INVALID_INPUT");

    const result = await createManualAssignment(ctx, {
      userId: body.userId,
      courseId: body.courseId,
      dueDate: dueDate.value,
      note: body.note,
    } as ManualAssignmentInput);

    if (!result.ok) return skipResponse(result.reason, result.prerequisites);

    return Response.json(
      { outcome: result.outcome, status: result.status, assignment: { id: result.assignment.id } },
      { status: result.outcome === "created" ? 201 : 200 }
    );
  } catch (err) {
    return errorResponse(
      err,
      "Failed to create assignment",
      "Couldn't assign that course. Please try again."
    );
  }
}
