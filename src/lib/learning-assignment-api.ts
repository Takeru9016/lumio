import type { AssignmentSource } from "@/generated/prisma/enums";
import { AuthContextError } from "@/lib/auth/context";
import type { AdminAssignmentFilters } from "@/lib/domain/learning-assignment/adminAssignments";
import type { AssignmentStatus } from "@/lib/domain/learning-assignment/status";
import type { AssignmentSkipReason } from "@/lib/domain/learning-assignment/types";

/**
 * The HTTP face of the assignment domain for the organisation admin routes.
 * Business rules live in the domain; this module only decides how a domain
 * answer is spoken over HTTP: which status, and prose that never echoes an enum
 * name, an id, a tenant or a database message.
 */

const GENERIC_INVALID = "Check the learner, course, due date and note, then try again.";

// A table (not a switch) so a new AssignmentSkipReason is a compile error here.
const SKIP_RESPONSES = {
  INVALID_INPUT: { status: 400, message: GENERIC_INVALID },
  LEARNER_NOT_ELIGIBLE: {
    status: 404,
    message: "That learner isn't available to assign learning to.",
  },
  COURSE_NOT_FOUND: { status: 404, message: "That course isn't available to assign." },
  COURSE_NOT_PUBLISHED: {
    status: 422,
    message: "That course isn't published yet, so it can't be assigned.",
  },
  COURSE_REQUIRES_PAYMENT: { status: 422, message: "Paid courses can't be assigned yet." },
  ENROLLMENT_REFUNDED: {
    status: 409,
    message: "This learner's access to that course was refunded, so it can't be assigned.",
  },
  ASSIGNMENT_CONFLICT: {
    status: 409,
    message: "This assignment can't be created because a conflicting record exists.",
  },
  // The remaining reasons belong to the mandatory and capability-gap sources,
  // which these routes never create; if one is ever reached it is a bad request.
  MANDATORY_TRAINING_NOT_FOUND: { status: 400, message: GENERIC_INVALID },
  LEARNER_NOT_IN_TEAM: { status: 400, message: GENERIC_INVALID },
  GAP_NOT_FOUND: { status: 400, message: GENERIC_INVALID },
  GAP_ALREADY_MET: { status: 400, message: GENERIC_INVALID },
  COURSE_DOES_NOT_ADDRESS_SKILL: { status: 400, message: GENERIC_INVALID },
  PREREQUISITES_NOT_MET: {
    status: 409,
    message: "This learner hasn't completed the prerequisite courses for that course yet.",
  },
} satisfies Record<AssignmentSkipReason, { status: number; message: string }>;

export function skipResponse(
  reason: AssignmentSkipReason,
  prerequisites?: { courseId: string; slug: string; title: string }[]
): Response {
  const { status, message } = SKIP_RESPONSES[reason];
  // The machine-readable code and the remaining prerequisites accompany only the
  // prerequisite refusal, and only when the caller has them.
  if (reason === "PREREQUISITES_NOT_MET" && prerequisites) {
    return Response.json({ error: message, code: reason, prerequisites }, { status });
  }
  return Response.json({ error: message }, { status });
}

export function cancelFailureResponse(reason: "ASSIGNMENT_NOT_FOUND" | "ASSIGNMENT_COMPLETED") {
  return reason === "ASSIGNMENT_NOT_FOUND"
    ? Response.json({ error: "Assignment not found." }, { status: 404 })
    : Response.json(
        { error: "This assignment is completed, so it can't be cancelled." },
        { status: 409 }
      );
}

/** Auth failures keep their own status; anything else is logged and answered generically. */
export function errorResponse(err: unknown, logLabel: string, publicMessage: string): Response {
  if (err instanceof AuthContextError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  console.error(`[assignments] ${logLabel}`, err);
  return Response.json({ error: publicMessage }, { status: 500 });
}

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type DueDateInput = { ok: true; value: Date | null | undefined } | { ok: false };

/**
 * Turns the wire value of `dueDate` into what the domain takes.
 *
 *   omitted      -> undefined  leave an existing due date alone
 *   null         -> null       clear it
 *   "YYYY-MM-DD" -> the END of that day in UTC, the platform's convention for a
 *                  calendar deadline (the learner's label shows that same date)
 *   ISO datetime -> that exact instant
 *
 * The calendar date is round-tripped because JavaScript quietly rolls
 * "2026-02-31" over to 3 March; a date the admin could not have meant is
 * rejected instead of being silently moved. Whether a past or far-future value
 * is acceptable is not decided here: the domain owns that (and past dates are
 * still allowed, L-4).
 */
export function parseDueDateInput(value: unknown): DueDateInput {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false };

  if (CALENDAR_DATE.test(value)) {
    const endOfDay = new Date(`${value}T23:59:59.999Z`);
    if (Number.isNaN(endOfDay.getTime()) || endOfDay.toISOString().slice(0, 10) !== value) {
      return { ok: false };
    }
    return { ok: true, value: endOfDay };
  }

  if (value.includes("T")) {
    const instant = new Date(value);
    if (!Number.isNaN(instant.getTime())) return { ok: true, value: instant };
  }
  return { ok: false };
}

export const ASSIGNMENT_SOURCES: readonly AssignmentSource[] = [
  "MANUAL",
  "MANDATORY",
  "CAPABILITY_GAP",
];
export const ASSIGNMENT_STATUSES: readonly AssignmentStatus[] = [
  "ASSIGNED",
  "STARTED",
  "OVERDUE",
  "COMPLETED",
  "CANCELLED",
];

export type FilterInput = { ok: true; filters: AdminAssignmentFilters } | { ok: false };

/**
 * The list's `source` and `status` filters from a URL. Absent, empty and "all"
 * mean "no filter"; anything that is not a known value is rejected rather than
 * silently ignored, so a typo never shows an unfiltered list as if it were
 * filtered.
 */
export function parseAssignmentFilters(input: {
  source?: string | null;
  status?: string | null;
}): FilterInput {
  const filters: AdminAssignmentFilters = {};

  const source = input.source?.trim().toUpperCase();
  if (source && source !== "ALL") {
    const match = ASSIGNMENT_SOURCES.find((s) => s === source);
    if (!match) return { ok: false };
    filters.source = match;
  }

  const status = input.status?.trim().toUpperCase();
  if (status && status !== "ALL") {
    const match = ASSIGNMENT_STATUSES.find((s) => s === status);
    if (!match) return { ok: false };
    filters.status = match;
  }
  return { ok: true, filters };
}
