import type { LearnerPathCourse } from "@/lib/domain/learner-path/availability";
import { type ApiFailure, requestJson } from "@/lib/path-request";

/**
 * The browser side of the learner learning path routes. The two reads are the
 * whole learner surface: a page of the tenant's published paths, and one path with
 * its courses. Everything on them (availability, prerequisite state, progress) is
 * derived by the server; this module only carries it and words a failure.
 */

export const LEARNER_PATHS_API = "/api/paths";

export type LearnerProgress = {
  completed: number;
  available: number;
  /** null when there is nothing to measure (no completed and no available course). */
  percentage: number | null;
};

export type LearnerPathListItem = {
  id: string;
  title: string;
  description: string | null;
  status: "PUBLISHED";
  publishedAt: string | null;
  courseCount: number;
  progress: LearnerProgress;
};

export type LearnerPathPage = {
  paths: LearnerPathListItem[];
  hasMore: boolean;
  nextCursor: string | null;
};

export type LearnerPath = {
  id: string;
  title: string;
  description: string | null;
  status: "PUBLISHED";
  publishedAt: string | null;
  courses: LearnerPathCourse[];
  progress: LearnerProgress;
};

export type LearnerLoad<T> =
  | { kind: "ready"; data: T }
  | { kind: "not_found" }
  | { kind: "error"; message: string };

const GENERIC_LOAD_ERROR = "Something went wrong while loading. Please try again.";
const SESSION_ERROR = "Your session has ended. Sign in again to see your learning paths.";
const ACCESS_ERROR = "Learning paths are available to learners in an organisation.";

function failureMessage(failure: ApiFailure): string {
  if (failure.status === 401) return SESSION_ERROR;
  if (failure.status === 403 || failure.status === 400) return ACCESS_ERROR;
  return GENERIC_LOAD_ERROR;
}

export function learnerListUrl(cursor: string | null): string {
  return cursor ? `${LEARNER_PATHS_API}?cursor=${encodeURIComponent(cursor)}` : LEARNER_PATHS_API;
}

export async function loadLearnerPaths(
  cursor: string | null,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<LearnerLoad<LearnerPathPage>> {
  const result = await requestJson<LearnerPathPage>(learnerListUrl(cursor), { signal }, fetchImpl);
  if (result.kind === "ok") return { kind: "ready", data: result.data };
  // A cursor the server no longer accepts is a bad link, not a broken page: 400 with a cursor.
  if (result.status === 400 && cursor) return { kind: "not_found" };
  return { kind: "error", message: failureMessage(result) };
}

export async function loadLearnerPath(
  pathId: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<LearnerLoad<LearnerPath>> {
  const result = await requestJson<{ path: LearnerPath }>(
    `${LEARNER_PATHS_API}/${encodeURIComponent(pathId)}`,
    { signal },
    fetchImpl
  );
  if (result.kind === "ok") return { kind: "ready", data: result.data.path };
  if (result.status === 404) return { kind: "not_found" };
  return { kind: "error", message: failureMessage(result) };
}
