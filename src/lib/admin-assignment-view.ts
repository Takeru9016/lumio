import type { AssignmentSource } from "@/generated/prisma/enums";
import type {
  AdminAssignment,
  AdminReason,
} from "@/lib/domain/learning-assignment/adminAssignments";
import type { AssignmentStatus } from "@/lib/domain/learning-assignment/status";
import { formatDueDate, PROFICIENCY_LABELS } from "@/lib/learner-assignment-view";

/**
 * How the organisation admin's assignment list is worded. Everything here is
 * presentation of what the domain already decided (status, provenance,
 * cancellation), and everything it emits is a plain string or boolean, so it
 * can cross from the server page into the client components unchanged.
 *
 * Dates use the UTC calendar date on purpose: it is what an admin's due date
 * means (see formatDueDate), and it renders identically on the server, in the
 * browser and in tests, which is what keeps hydration stable.
 */

export const SOURCE_LABELS: Record<AssignmentSource, string> = {
  MANUAL: "Manual",
  MANDATORY: "Mandatory",
  CAPABILITY_GAP: "Capability gap",
};

export const STATUS_LABELS: Record<AssignmentStatus, string> = {
  ASSIGNED: "Assigned",
  STARTED: "In progress",
  OVERDUE: "Overdue",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

export type AdminRowView = {
  id: string;
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
  source: AssignmentSource;
  sourceLabel: string;
  status: AssignmentStatus;
  statusLabel: string;
  due: { label: string; iso: string } | null;
  created: { label: string; iso: string };
  reason: { headline: string; note: string | null };
  /** Set while the assignment is cancelled. */
  cancellation: string | null;
  /** Set for an active assignment that has been cancelled and reactivated before. */
  history: string | null;
  canCancel: boolean;
  /** "Sam Lee, SQL Basics": what a control's accessible name is built from. */
  subject: string;
};

function level(value: string | null): string | null {
  return value ? (PROFICIENCY_LABELS[value] ?? null) : null;
}

function presentReason(reason: AdminReason): { headline: string; note: string | null } {
  switch (reason.kind) {
    case "MANUAL":
      return {
        headline: reason.assignedByName
          ? `Assigned by ${reason.assignedByName}`
          : "Assigned manually",
        note: reason.note,
      };
    case "MANDATORY":
      return {
        headline: reason.teamName
          ? `Mandatory training for ${reason.teamName}`
          : "Mandatory training",
        note: null,
      };
    case "CAPABILITY_GAP": {
      const current = level(reason.currentProficiency);
      const required = level(reason.requiredProficiency);
      const gap =
        reason.skillName && current && required
          ? `${reason.skillName}, ${current} to ${required}`
          : (reason.skillName ?? "a skill gap");
      return {
        headline: reason.roleName
          ? `Capability gap for ${reason.roleName}: ${gap}`
          : `Capability gap: ${gap}`,
        note: null,
      };
    }
    default:
      return { headline: "Assigned", note: null };
  }
}

function by(name: string | null): string {
  return name ? ` by ${name}` : "";
}

const day = (date: Date) => formatDueDate(date.toISOString()) ?? "an unknown date";

export function presentAdminAssignment(a: AdminAssignment): AdminRowView {
  const learnerName = a.learner.name?.trim() || a.learner.email;
  return {
    id: a.id,
    learnerName,
    learnerEmail: a.learner.email,
    courseTitle: a.course.title,
    source: a.source,
    sourceLabel: SOURCE_LABELS[a.source],
    status: a.status,
    statusLabel: STATUS_LABELS[a.status],
    due: a.dueDate ? { label: day(a.dueDate), iso: a.dueDate.toISOString() } : null,
    created: { label: day(a.createdAt), iso: a.createdAt.toISOString() },
    reason: presentReason(a.reason),
    cancellation: a.cancellation
      ? `Cancelled ${day(a.cancellation.at)}${by(a.cancellation.byName)}`
      : null,
    history: a.previousCancellation
      ? `Previously cancelled ${day(a.previousCancellation.at)}${by(a.previousCancellation.byName)}${
          a.previousCancellation.count > 1 ? ` (${a.previousCancellation.count} times)` : ""
        }`
      : null,
    canCancel: a.status !== "CANCELLED" && a.status !== "COMPLETED",
    subject: `${learnerName}, ${a.course.title}`,
  };
}

export const SOURCE_FILTERS: { value: AssignmentSource | null; label: string }[] = [
  { value: null, label: "All sources" },
  { value: "MANUAL", label: "Manual" },
  { value: "MANDATORY", label: "Mandatory" },
  { value: "CAPABILITY_GAP", label: "Capability gap" },
];

export const STATUS_FILTERS: { value: AssignmentStatus | null; label: string }[] = [
  { value: null, label: "All statuses" },
  { value: "ASSIGNED", label: "Assigned" },
  { value: "STARTED", label: "In progress" },
  { value: "OVERDUE", label: "Overdue" },
  { value: "COMPLETED", label: "Completed" },
  { value: "CANCELLED", label: "Cancelled" },
];

export const ASSIGNMENTS_PATH = "/org/assignments";

/**
 * The list URL for a filter combination; the default (all) leaves the query
 * empty. A cursor, when given, is the position of an older page under the same
 * filters; changing a filter never carries one, so it always returns to the newest.
 */
export function filterHref(filters: {
  source?: AssignmentSource | null;
  status?: AssignmentStatus | null;
  cursor?: string | null;
}): string {
  const params = new URLSearchParams();
  if (filters.source) params.set("source", filters.source.toLowerCase());
  if (filters.status) params.set("status", filters.status.toLowerCase());
  if (filters.cursor) params.set("cursor", filters.cursor);
  const query = params.toString();
  return query ? `${ASSIGNMENTS_PATH}?${query}` : ASSIGNMENTS_PATH;
}

/** True when a `YYYY-MM-DD` value is before today's UTC calendar date. */
export function isPastCalendarDate(value: string, now: Date = new Date()): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && value < now.toISOString().slice(0, 10);
}
