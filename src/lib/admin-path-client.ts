import { type ApiFailure, type ApiResult, jsonInit, requestJson } from "@/lib/path-request";

/**
 * The browser side of the organisation admin learning path routes. Each request
 * carries only what a person chooses (a title, a description, a course, an order)
 * and nothing else: no tenant, no actor, no status, no position. Those are the
 * server's to decide, and a request that named them would be refused.
 *
 * A failure comes back as words for a person (`message`), never as a code or a
 * raw server string, together with whether the screen should re-read the path
 * because what it was showing is now out of date.
 */

export const ORG_PATHS_API = "/api/org/paths";

export type PathStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";
export type PathBlockReason = "WRONG_TENANT" | "ARCHIVED" | "NOT_PUBLISHED" | "NO_PUBLISHED_LESSON";

export type AdminPathSummary = {
  id: string;
  title: string;
  description: string | null;
  status: PathStatus;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  courseCount: number;
};

export type AdminPathCourse = {
  courseId: string;
  slug: string;
  title: string;
  position: number;
  courseStatus: PathStatus;
  availability: "AVAILABLE" | "UNAVAILABLE";
  blockReason: PathBlockReason | null;
};

export type AdminPath = Omit<AdminPathSummary, "courseCount"> & {
  courses: AdminPathCourse[];
};

export type AdminPathPage = {
  paths: AdminPathSummary[];
  hasMore: boolean;
  nextCursor: string | null;
};

/** A course an administrator can pick from when adding to a path; the server still decides whether it may join. */
export type PathCourseChoice = {
  id: string;
  title: string;
  slug: string;
  status: PathStatus;
};

export type ListQuery = { status: PathStatus | null; cursor: string | null };

export type AdminFailure = {
  message: string;
  /** Domain code, for the screen's own branching; never shown. */
  code: string | null;
  status: number | null;
  /** What the server said blocks a publish, verbatim; empty for every other failure. */
  problems: readonly unknown[];
  /** The path the screen holds is out of date: read it again before doing anything else. */
  refresh: boolean;
};

export type AdminResult<T> = { kind: "ok"; data: T } | { kind: "error"; failure: AdminFailure };

export type AdminLoad<T> =
  | { kind: "ready"; data: T }
  | { kind: "not_found" }
  | { kind: "error"; failure: AdminFailure };

/** What a request was trying to do, for the two answers whose meaning depends on it. */
export type Intent = "read" | "change" | "publish";

const NETWORK = "Couldn't reach the server. Check your connection and try again.";
const GENERIC = "Something went wrong. Please try again.";

const CODE_MESSAGES: Record<string, string> = {
  NOT_FOUND: "This learning path isn't available. It may have been removed.",
  COURSE_NOT_FOUND: "That course couldn't be found in your organisation.",
  INVALID_TRANSITION: "The path can't change to that status from where it is now.",
  PATH_ARCHIVED: "This path is archived, so it can't be changed. Republish it to edit it again.",
  COURSE_ARCHIVED: "Archived courses can't be added to a path.",
  DUPLICATE: "That course is already in this path.",
  LAST_COURSE:
    "A published path must keep at least one course. Add another course first, or archive the path.",
  STALE_ORDER: "Another change was made to this path's courses. The current order is shown.",
};

/**
 * A validation message (INVALID_INPUT, LIMIT_REACHED) is the domain's own short
 * prose about the value, so it is passed on; every other answer has fixed words
 * here. A status with no code is an authorization or infrastructure answer.
 */
export function describeFailure(failure: ApiFailure, intent: Intent): AdminFailure {
  const refresh = failure.status === 404 || failure.status === 409;
  const base = { code: failure.code, status: failure.status, problems: failure.problems, refresh };

  if (failure.status === null) return { ...base, message: NETWORK };
  if (failure.status === 401) {
    return { ...base, message: "Your session has ended. Sign in again to continue." };
  }
  if (failure.status === 403) {
    return { ...base, message: "You don't have permission to manage learning paths." };
  }
  if (failure.code === "PATH_NOT_PUBLISHABLE") {
    return {
      ...base,
      message:
        intent === "publish"
          ? "This path can't be published yet."
          : "That change would leave the path unable to be published.",
    };
  }
  if (failure.code === "INVALID_INPUT" || failure.code === "LIMIT_REACHED") {
    return { ...base, message: failure.serverMessage ?? "Check the details and try again." };
  }
  if (failure.code && CODE_MESSAGES[failure.code]) {
    return { ...base, message: CODE_MESSAGES[failure.code] };
  }
  return {
    ...base,
    message: failure.status >= 500 ? GENERIC : "That didn't work. Please try again.",
  };
}

function settle<T>(result: ApiResult<T>, intent: Intent): AdminResult<T> {
  return result.kind === "ok"
    ? { kind: "ok", data: result.data }
    : { kind: "error", failure: describeFailure(result, intent) };
}

const pathUrl = (pathId: string) => `${ORG_PATHS_API}/${encodeURIComponent(pathId)}`;

export function listUrl({ status, cursor }: ListQuery): string {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (cursor) params.set("cursor", cursor);
  const query = params.toString();
  return query ? `${ORG_PATHS_API}?${query}` : ORG_PATHS_API;
}

export async function loadAdminPaths(
  query: ListQuery,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<AdminLoad<AdminPathPage>> {
  const result = await requestJson<AdminPathPage>(listUrl(query), { signal }, fetchImpl);
  if (result.kind === "ok") return { kind: "ready", data: result.data };
  // A cursor that no longer parses is a stale link, not a broken page.
  if (result.status === 400 && query.cursor) return { kind: "not_found" };
  return { kind: "error", failure: describeFailure(result, "read") };
}

export async function loadAdminPath(
  pathId: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<AdminLoad<AdminPath>> {
  const result = await requestJson<{ path: AdminPath }>(pathUrl(pathId), { signal }, fetchImpl);
  if (result.kind === "ok") return { kind: "ready", data: result.data.path };
  if (result.status === 404) return { kind: "not_found" };
  return { kind: "error", failure: describeFailure(result, "read") };
}

export type PathFields = { title: string; description: string };

/** An empty description is sent as null, which is "no description" and the same thing to the server. */
function fieldsBody({ title, description }: PathFields) {
  const trimmed = description.trim();
  return { title, description: trimmed === "" ? null : description };
}

export async function createPath(
  fields: PathFields,
  fetchImpl: typeof fetch = fetch
): Promise<AdminResult<AdminPathSummary>> {
  const result = await requestJson<{ path: AdminPathSummary }>(
    ORG_PATHS_API,
    jsonInit("POST", fieldsBody(fields)),
    fetchImpl
  );
  return result.kind === "ok" ? { kind: "ok", data: result.data.path } : settle(result, "change");
}

export async function updatePath(
  pathId: string,
  fields: PathFields,
  fetchImpl: typeof fetch = fetch
): Promise<AdminResult<AdminPathSummary>> {
  const result = await requestJson<{ path: AdminPathSummary }>(
    pathUrl(pathId),
    jsonInit("PATCH", fieldsBody(fields)),
    fetchImpl
  );
  return result.kind === "ok" ? { kind: "ok", data: result.data.path } : settle(result, "change");
}

export async function addCourse(
  pathId: string,
  courseId: string,
  fetchImpl: typeof fetch = fetch
): Promise<AdminResult<AdminPath>> {
  const result = await requestJson<{ path: AdminPath }>(
    `${pathUrl(pathId)}/courses`,
    jsonInit("POST", { courseId }),
    fetchImpl
  );
  return result.kind === "ok" ? { kind: "ok", data: result.data.path } : settle(result, "change");
}

export async function removeCourse(
  pathId: string,
  courseId: string,
  fetchImpl: typeof fetch = fetch
): Promise<AdminResult<AdminPath>> {
  const result = await requestJson<{ path: AdminPath }>(
    `${pathUrl(pathId)}/courses/${encodeURIComponent(courseId)}`,
    jsonInit("DELETE"),
    fetchImpl
  );
  return result.kind === "ok" ? { kind: "ok", data: result.data.path } : settle(result, "change");
}

/** The complete list of course ids in the wanted order; the server assigns the positions. */
export async function reorderCourses(
  pathId: string,
  courseIds: readonly string[],
  fetchImpl: typeof fetch = fetch
): Promise<AdminResult<AdminPath>> {
  const result = await requestJson<{ path: AdminPath }>(
    `${pathUrl(pathId)}/reorder`,
    jsonInit("POST", { courseIds }),
    fetchImpl
  );
  return result.kind === "ok" ? { kind: "ok", data: result.data.path } : settle(result, "change");
}

/** Publish and republish are the same request: the server decides which one it is. */
export async function publishPath(
  pathId: string,
  fetchImpl: typeof fetch = fetch
): Promise<AdminResult<AdminPathSummary>> {
  const result = await requestJson<{ path: AdminPathSummary }>(
    `${pathUrl(pathId)}/publish`,
    jsonInit("POST"),
    fetchImpl
  );
  return result.kind === "ok" ? { kind: "ok", data: result.data.path } : settle(result, "publish");
}

export async function archivePath(
  pathId: string,
  fetchImpl: typeof fetch = fetch
): Promise<AdminResult<AdminPathSummary>> {
  const result = await requestJson<{ path: AdminPathSummary }>(
    `${pathUrl(pathId)}/archive`,
    jsonInit("POST"),
    fetchImpl
  );
  return result.kind === "ok" ? { kind: "ok", data: result.data.path } : settle(result, "change");
}
