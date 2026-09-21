import type { LearnerAssignment } from "@/lib/domain/learning-assignment/learnerAssignments";
import type { AssignmentStatus } from "@/lib/domain/learning-assignment/status";

export const ASSIGNMENTS_ENDPOINT = "/api/assignments/me";

type LiveStatus = Exclude<AssignmentStatus, "CANCELLED">;

const LIVE_STATUSES: readonly LiveStatus[] = ["ASSIGNED", "STARTED", "OVERDUE", "COMPLETED"];

export const PROFICIENCY_LABELS: Record<string, string> = {
  NONE: "none",
  BEGINNER: "beginner",
  INTERMEDIATE: "intermediate",
  ADVANCED: "advanced",
  EXPERT: "expert",
};

/**
 * The reason as the card needs it. Every field is optional information: a
 * malformed or missing snapshot still produces a valid reason, just a less
 * specific one, so a bad row can never break the card (or the list).
 */
export type AssignmentReason =
  | { kind: "MANUAL"; assignedByName: string | null; note: string | null }
  | { kind: "MANDATORY"; teamName: string | null }
  | {
      kind: "CAPABILITY_GAP";
      roleName: string | null;
      skill: { name: string; current: string; required: string } | null;
    }
  | { kind: "UNKNOWN" };

/**
 * What the browser reads from GET /api/assignments/me. Deliberately a subset:
 * `courseId`, `createdAt` and any administrative field the server might one day
 * add are not carried into the UI, and the course link is built from the slug.
 */
export type AssignmentItem = {
  id: string;
  courseSlug: string;
  courseTitle: string;
  source: string;
  reason: AssignmentReason;
  dueDate: string | null;
  status: LiveStatus;
};

export type AssignedLearningResult =
  | { kind: "ready"; assignments: AssignmentItem[] }
  | { kind: "error" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function proficiencyLabel(value: unknown): string | null {
  return typeof value === "string" ? (PROFICIENCY_LABELS[value] ?? null) : null;
}

function parseReason(source: unknown, raw: unknown): AssignmentReason {
  const reason = isRecord(raw) ? raw : {};

  if (source === "MANUAL") {
    return {
      kind: "MANUAL",
      assignedByName: nonEmptyString(reason.assignedByName),
      note: nonEmptyString(reason.note),
    };
  }
  if (source === "MANDATORY") {
    return { kind: "MANDATORY", teamName: nonEmptyString(reason.teamName) };
  }
  if (source === "CAPABILITY_GAP") {
    const name = nonEmptyString(reason.skillName);
    const current = proficiencyLabel(reason.currentProficiency);
    const required = proficiencyLabel(reason.requiredProficiency);
    return {
      kind: "CAPABILITY_GAP",
      roleName: nonEmptyString(reason.roleName),
      skill: name && current && required ? { name, current, required } : null,
    };
  }
  return { kind: "UNKNOWN" };
}

function parseDueDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return Number.isNaN(new Date(value).getTime()) ? null : value;
}

/** Returns null for an item that cannot be rendered honestly (no id, slug, title or known status). */
export function parseAssignmentItem(raw: unknown): AssignmentItem | null {
  if (!isRecord(raw)) return null;

  const id = nonEmptyString(raw.id);
  const courseSlug = nonEmptyString(raw.courseSlug);
  const courseTitle = nonEmptyString(raw.courseTitle);
  const status = LIVE_STATUSES.find((s) => s === raw.status);
  if (!id || !courseSlug || !courseTitle || !status) return null;

  return {
    id,
    courseSlug,
    courseTitle,
    source: typeof raw.source === "string" ? raw.source : "",
    reason: parseReason(raw.source, raw.reason),
    dueDate: parseDueDate(raw.dueDate),
    status,
  };
}

/** Null means the envelope itself is not the documented `{ assignments: [...] }`. */
export function parseAssignmentsResponse(body: unknown): AssignmentItem[] | null {
  if (!isRecord(body) || !Array.isArray(body.assignments)) return null;
  return body.assignments
    .map((raw) => parseAssignmentItem(raw))
    .filter((item): item is AssignmentItem => item !== null);
}

/** For server components that read the domain function directly; goes through the same parser as the API path. */
export function itemFromLearnerAssignment(assignment: LearnerAssignment): AssignmentItem | null {
  return parseAssignmentItem({ ...assignment, dueDate: assignment.dueDate?.toISOString() ?? null });
}

/**
 * The learner's identity is the session cookie. The URL deliberately has no
 * parameters, and this is a plain GET: nothing here can name another user or
 * tenant, or change anything.
 *
 * 400 is "No organisation found": a solo learner has no tenant and therefore
 * nothing can be assigned to them. That is an empty list, not a failure.
 */
export async function loadAssignedLearning(
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<AssignedLearningResult> {
  try {
    const res = await fetchImpl(ASSIGNMENTS_ENDPOINT, { method: "GET", signal });
    if (res.status === 400) return { kind: "ready", assignments: [] };
    if (!res.ok) return { kind: "error" };

    const assignments = parseAssignmentsResponse(await res.json());
    return assignments ? { kind: "ready", assignments } : { kind: "error" };
  } catch {
    return { kind: "error" };
  }
}

const DUE_DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  year: "numeric",
});

/**
 * A due date is a calendar date, not a moment on the viewer's clock. Everything
 * in the platform writes it as a UTC instant that names that date: a date input's
 * "YYYY-MM-DD" becomes UTC midnight (`new Date("2026-09-25")`), and the fixtures
 * and reports use end-of-day UTC (`23:59:59.999Z`). Both mean "25 September".
 *
 * Formatting in the viewer's zone breaks that: end-of-day UTC is 05:29 on the
 * 26th in India, and UTC midnight is still the 24th in Los Angeles. Formatting
 * in UTC returns the date whoever chose it meant, wherever the learner is, and is
 * identical on the server, in the browser and in tests. There is deliberately no
 * per-user timezone: the stored instant (which decides when the status becomes
 * OVERDUE) is unchanged, only the label is anchored to the calendar date.
 */
export function formatDueDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : DUE_DATE_FORMAT.format(date);
}

export type ReasonView = { headline: string; detail: string | null; note: string | null };

function presentReason(reason: AssignmentReason): ReasonView {
  switch (reason.kind) {
    case "MANUAL":
      return {
        headline: reason.assignedByName
          ? `Assigned by ${reason.assignedByName}`
          : "Assigned to you",
        detail: null,
        note: reason.note,
      };
    case "MANDATORY":
      return {
        headline: reason.teamName
          ? `Required for your team: ${reason.teamName}`
          : "Required for your team",
        detail: null,
        note: null,
      };
    case "CAPABILITY_GAP":
      return {
        headline: reason.roleName
          ? `Recommended for your role: ${reason.roleName}`
          : "Recommended for your role",
        detail: reason.skill
          ? `${reason.skill.name}: ${reason.skill.current} to ${reason.skill.required}`
          : null,
        note: null,
      };
    default:
      return { headline: "Assigned to you", detail: null, note: null };
  }
}

export const STATUS_LABELS: Record<LiveStatus, string> = {
  ASSIGNED: "Assigned",
  STARTED: "In progress",
  OVERDUE: "Overdue",
  COMPLETED: "Completed",
};

const CTA_LABELS: Record<LiveStatus, string> = {
  ASSIGNED: "Start course",
  STARTED: "Continue",
  OVERDUE: "Continue",
  COMPLETED: "Review",
};

export type ProgressView = { percent: number; caveat: string | null };

const PUBLISHED_ONLY_CAVEAT = "Progress counts only lessons that are currently published.";

/**
 * L-5. The assignment status is authoritative and is never re-derived here.
 *
 * STARTED means "the learner has a completed-lesson record somewhere in this
 * course", including a lesson that has since been unpublished or archived. The
 * dashboard's percentage counts published lessons only. So a STARTED assignment
 * can legitimately sit at 0% (its only progress is on a lesson that is no longer
 * counted, or is under half a percent). The bar is shown as-is and that case
 * gets an explicit note; a percentage is never adjusted to agree with the status.
 *
 * ASSIGNED and COMPLETED show no bar: for those the status already says all
 * there is to say, and a number could only contradict it.
 */
export function presentProgress(
  status: AssignmentStatus,
  percent: number | undefined
): ProgressView | null {
  if (status !== "STARTED" && status !== "OVERDUE") return null;
  if (percent === undefined || Number.isNaN(percent)) return null;

  const clamped = Math.min(100, Math.max(0, Math.round(percent)));
  return {
    percent: clamped,
    caveat: status === "STARTED" && clamped === 0 ? PUBLISHED_ONLY_CAVEAT : null,
  };
}

export type AssignmentView = {
  id: string;
  title: string;
  href: string;
  status: LiveStatus;
  statusLabel: string;
  ctaLabel: string;
  reason: ReasonView;
  due: { label: string; iso: string } | null;
};

export function presentAssignment(item: AssignmentItem): AssignmentView {
  const dueLabel = formatDueDate(item.dueDate);
  return {
    id: item.id,
    title: item.courseTitle,
    href: `/courses/${encodeURIComponent(item.courseSlug)}`,
    status: item.status,
    statusLabel: STATUS_LABELS[item.status],
    ctaLabel: CTA_LABELS[item.status],
    reason: presentReason(item.reason),
    due: item.dueDate && dueLabel ? { label: dueLabel, iso: item.dueDate } : null,
  };
}
