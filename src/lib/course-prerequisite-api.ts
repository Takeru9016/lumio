import type { PrerequisitesNotMetError } from "@/lib/domain/course/prerequisites";

/**
 * How a failed prerequisite gate is spoken over HTTP, shared by every route that
 * can create an enrollment (or the payment order that precedes one). A 409 with
 * the stable machine-readable `code` and the prerequisites that remain, so a
 * screen can list them; the prose never names an id, a tenant or an exception.
 */
export function prerequisitesNotMetResponse(err: PrerequisitesNotMetError): Response {
  return Response.json(
    {
      error: "Complete the prerequisite courses first.",
      code: err.code,
      prerequisites: err.prerequisites,
    },
    { status: err.status }
  );
}
