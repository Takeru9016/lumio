import {
  type AuthContext,
  AuthContextError,
  requireAuthContext,
  requireRole,
  requireTenant,
} from "@/lib/auth/context";
import {
  fail,
  LearningPathError,
  type LearningPathErrorCode,
  PathNotPublishableError,
  type PublishabilityProblem,
} from "@/lib/domain/learning-path/types";

/**
 * The HTTP face of the learning path domain for the organisation admin routes.
 * The rules live in the domain; this module only decides how a domain answer is
 * spoken over HTTP. Domain messages are prose that never names an id, a tenant or a
 * database message, and nothing else (a Prisma error, a stack) is ever put in a body.
 */

/** The session's ORG_ADMIN and tenant, the same sequence every org admin route uses. */
export async function resolvePathAdmin(): Promise<AuthContext & { tenantId: string }> {
  const ctx = await requireAuthContext();
  requireTenant(ctx);
  requireRole(ctx, ["ORG_ADMIN"]);
  return ctx;
}

/** The JSON body of a request, or INVALID_INPUT when there is none or it is not JSON. */
export async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw fail.invalid("Invalid request");
  }
}

// A record (not a switch) so a new LearningPathErrorCode is a compile error here.
const STATUS = {
  INVALID_INPUT: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  COURSE_NOT_FOUND: 404,
  INVALID_TRANSITION: 409,
  PATH_ARCHIVED: 409,
  COURSE_ARCHIVED: 409,
  DUPLICATE: 409,
  LIMIT_REACHED: 409,
  LAST_COURSE: 409,
  PATH_NOT_PUBLISHABLE: 409,
  STALE_ORDER: 409,
} satisfies Record<LearningPathErrorCode, number>;

/**
 * What an administrator is told about a blocking course. A course of another
 * tenant is named by id only: it can never be one of this path's, but if one ever
 * were, its title is not this administrator's to read.
 */
function publicProblem(problem: PublishabilityProblem) {
  if (problem.kind !== "COURSE") return { kind: problem.kind };
  return problem.reason === "WRONG_TENANT"
    ? { kind: problem.kind, courseId: problem.courseId, reason: problem.reason }
    : {
        kind: problem.kind,
        courseId: problem.courseId,
        title: problem.title,
        reason: problem.reason,
      };
}

/** Auth failures and domain errors keep their own status; anything else is logged and answered generically. */
export function pathErrorResponse(err: unknown, logLabel: string, publicMessage: string): Response {
  if (err instanceof AuthContextError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  if (err instanceof PathNotPublishableError) {
    return Response.json(
      { error: err.message, code: err.code, problems: err.problems.map(publicProblem) },
      { status: STATUS.PATH_NOT_PUBLISHABLE }
    );
  }
  if (err instanceof LearningPathError) {
    return Response.json({ error: err.message, code: err.code }, { status: STATUS[err.code] });
  }
  console.error(`[learning-paths] ${logLabel}`, err);
  return Response.json({ error: publicMessage }, { status: 500 });
}
