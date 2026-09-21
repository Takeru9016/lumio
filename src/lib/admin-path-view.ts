import type {
  AdminFailure,
  AdminPathCourse,
  AdminPathSummary,
  AdminResult,
  ListQuery,
  PathBlockReason,
  PathStatus,
} from "@/lib/admin-path-client";
import { formatDueDate } from "@/lib/learner-assignment-view";

/**
 * How the organisation admin's learning path screens are worded. It is
 * presentation only: which controls a status offers is a description of what the
 * lifecycle allows, and the server still decides every change (a control that is
 * shown can be refused, and one that is hidden proves nothing).
 */

export const ORG_PATHS_PATH = "/org/paths";

export const orgPathHref = (pathId: string) => `${ORG_PATHS_PATH}/${encodeURIComponent(pathId)}`;

export const STATUS_LABELS: Record<PathStatus, string> = {
  DRAFT: "Draft",
  PUBLISHED: "Published",
  ARCHIVED: "Archived",
};

export const STATUS_FILTERS: { label: string; value: PathStatus | null }[] = [
  { label: "All", value: null },
  { label: "Draft", value: "DRAFT" },
  { label: "Published", value: "PUBLISHED" },
  { label: "Archived", value: "ARCHIVED" },
];

/** A status the URL names, or null for "all": an unknown value never reaches the API. */
export function parseStatusFilter(raw: string | null | undefined): PathStatus | null {
  return STATUS_FILTERS.find((f) => f.value !== null && f.value === raw)?.value ?? null;
}

/** What the list asks the API for, from the page's own URL: the filter and the page cursor, nothing else. */
export function adminListQuery(params: URLSearchParams): ListQuery {
  return { status: parseStatusFilter(params.get("status")), cursor: params.get("cursor") };
}

export function filterHref(query: { status: PathStatus | null; cursor?: string | null }): string {
  const params = new URLSearchParams();
  if (query.status) params.set("status", query.status);
  if (query.cursor) params.set("cursor", query.cursor);
  const search = params.toString();
  return search ? `${ORG_PATHS_PATH}?${search}` : ORG_PATHS_PATH;
}

export function pluralCourses(count: number): string {
  return `${count} ${count === 1 ? "course" : "courses"}`;
}

export type PathRowView = {
  id: string;
  href: string;
  title: string;
  description: string | null;
  status: PathStatus;
  statusLabel: string;
  courseCountLabel: string;
  created: string | null;
  published: string | null;
};

export function presentPathRow(path: AdminPathSummary): PathRowView {
  return {
    id: path.id,
    href: orgPathHref(path.id),
    title: path.title,
    description: path.description?.trim() ? path.description : null,
    status: path.status,
    statusLabel: STATUS_LABELS[path.status],
    courseCountLabel: pluralCourses(path.courseCount),
    created: formatDueDate(path.createdAt),
    published: formatDueDate(path.publishedAt),
  };
}

/**
 * What each status offers, from the lifecycle: a draft and a published path can
 * be edited and have their courses managed, a draft is published, a published or
 * draft path is archived, and an archived path can only be read or republished.
 */
export type PathActions = {
  canEdit: boolean;
  canManageCourses: boolean;
  canPublish: boolean;
  canRepublish: boolean;
  canArchive: boolean;
};

export function pathActions(status: PathStatus): PathActions {
  const open = status !== "ARCHIVED";
  return {
    canEdit: open,
    canManageCourses: open,
    canPublish: status === "DRAFT",
    canRepublish: status === "ARCHIVED",
    canArchive: open,
  };
}

const BLOCK_REASON_LABELS: Record<PathBlockReason, string> = {
  WRONG_TENANT: "Not part of your organisation",
  ARCHIVED: "This course is archived",
  NOT_PUBLISHED: "This course isn't published yet",
  NO_PUBLISHED_LESSON: "This course has no published lessons",
};

export type AdminCourseView = {
  courseId: string;
  slug: string;
  title: string;
  positionLabel: string;
  statusLabel: string;
  courseStatus: PathStatus;
  /** Why a learner can't take this course right now, when the API says so. */
  blockNote: string | null;
};

export function presentAdminCourse(course: AdminPathCourse): AdminCourseView {
  return {
    courseId: course.courseId,
    slug: course.slug,
    title: course.title,
    positionLabel: String(course.position).padStart(2, "0"),
    statusLabel: STATUS_LABELS[course.courseStatus],
    courseStatus: course.courseStatus,
    blockNote: course.blockReason ? (BLOCK_REASON_LABELS[course.blockReason] ?? null) : null,
  };
}

/** The ids with the one at `index` moved by `delta`; a move off either end changes nothing. */
export function moveCourse(ids: readonly string[], index: number, delta: -1 | 1): string[] {
  const target = index + delta;
  if (index < 0 || index >= ids.length || target < 0 || target >= ids.length) return [...ids];
  const next = [...ids];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  return next;
}

export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

const PROBLEM_REASONS: Record<string, string> = {
  ARCHIVED: "is archived",
  NOT_PUBLISHED: "isn't published",
  NO_PUBLISHED_LESSON: "has no published lessons",
  WRONG_TENANT: "isn't part of your organisation",
};

export type ProblemView = {
  /** The course problems come first; `intro` counts them. */
  intro: string | null;
  items: { key: string; text: string }[];
};

/**
 * The blocking information of a refused publish, worded from exactly what the
 * server sent. A course it named only by id (another organisation's) is not given
 * a title here, and an entry it did not describe is not invented.
 */
export function describeProblems(problems: readonly unknown[]): ProblemView | null {
  const items: { key: string; text: string }[] = [];
  let courseProblems = 0;

  problems.forEach((raw, index) => {
    if (typeof raw !== "object" || raw === null) return;
    const problem = raw as Record<string, unknown>;

    if (problem.kind === "INVALID_TITLE") {
      items.push({ key: `title-${index}`, text: "The path needs a title." });
    } else if (problem.kind === "NO_COURSES") {
      items.push({ key: `none-${index}`, text: "The path has no courses. Add at least one." });
    } else if (problem.kind === "COURSE") {
      courseProblems += 1;
      const title = typeof problem.title === "string" ? problem.title : "A course";
      const reason =
        typeof problem.reason === "string" ? PROBLEM_REASONS[problem.reason] : undefined;
      items.push({
        key: `course-${typeof problem.courseId === "string" ? problem.courseId : index}`,
        text: reason ? `${title} ${reason}` : `${title} needs attention`,
      });
    }
  });

  if (items.length === 0) return null;
  return {
    intro:
      courseProblems > 0
        ? `${courseProblems} ${courseProblems === 1 ? "course needs" : "courses need"} attention:`
        : null,
    items,
  };
}

export type ChangePlan = {
  /** Shown as a success toast, or null when the change was refused. */
  toast: string | null;
  /** Read the path again: it changed, or the server says what is on screen is out of date. */
  refresh: boolean;
  /** Throw away a locally re-ordered draft: it was made from an order that no longer exists. */
  resetOrder: boolean;
  failure: AdminFailure | null;
};

/** What the editor does once a change has been answered. The screen only carries this out. */
export function planAfterChange(result: AdminResult<unknown>, success: string): ChangePlan {
  if (result.kind === "ok")
    return { toast: success, refresh: true, resetOrder: false, failure: null };
  const { failure } = result;
  return {
    toast: null,
    refresh: failure.refresh,
    resetOrder: failure.code === "STALE_ORDER",
    failure,
  };
}

/**
 * Where a refusal is shown. One that also means the screen was out of date is kept
 * at page level, because the form or list that asked can be gone once the path is
 * read again; any other stays with whoever asked, next to what they were doing.
 */
export function placeFailure(refusal: AdminFailure | null): {
  page: AdminFailure | null;
  local: AdminFailure | null;
} {
  if (refusal?.refresh) return { page: refusal, local: null };
  return { page: null, local: refusal };
}
