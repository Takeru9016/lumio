/**
 * The browser side of the admin assignment routes. It builds the request from
 * the four things a person actually chooses (learner, course, due date, note)
 * and nothing else: no tenant, no actor, no source, no key. Those are the
 * server's to derive, and a request that named them would be ignored anyway.
 */

export const ASSIGNMENTS_API = "/api/org/assignments";

export type AssignInput = {
  userId: string;
  courseId: string;
  /** A `YYYY-MM-DD` calendar date from a date input, or empty. */
  dueDate: string;
  note: string;
};

export type AssignResult =
  | { kind: "created" | "updated" | "reactivated" | "existing" }
  | { kind: "error"; message: string };

export type CancelResult =
  | { kind: "cancelled" | "already_cancelled" }
  | { kind: "error"; message: string };

const GENERIC_ASSIGN_ERROR = "Couldn't assign that course. Please try again.";
const GENERIC_CANCEL_ERROR = "Couldn't cancel that assignment. Please try again.";

const OUTCOMES = ["created", "updated", "reactivated", "existing"] as const;

/**
 * An empty due date is left OUT of the request rather than sent as null: on an
 * assignment that already exists, "no date given" must leave its date alone,
 * whereas null would clear it.
 */
export function buildAssignBody(input: AssignInput): Record<string, string> {
  const note = input.note.trim();
  return {
    userId: input.userId,
    courseId: input.courseId,
    ...(input.dueDate ? { dueDate: input.dueDate } : {}),
    ...(note ? { note } : {}),
  };
}

function serverMessage(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    const { error } = body as { error: unknown };
    if (typeof error === "string" && error.length > 0 && error.length < 300) return error;
  }
  return fallback;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export async function submitManualAssignment(
  input: AssignInput,
  fetchImpl: typeof fetch = fetch
): Promise<AssignResult> {
  try {
    const res = await fetchImpl(ASSIGNMENTS_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildAssignBody(input)),
    });
    const body = await readJson(res);
    if (!res.ok) return { kind: "error", message: serverMessage(body, GENERIC_ASSIGN_ERROR) };

    const outcome = (body as { outcome?: unknown } | null)?.outcome;
    const kind = OUTCOMES.find((o) => o === outcome);
    return kind ? { kind } : { kind: "error", message: GENERIC_ASSIGN_ERROR };
  } catch {
    return { kind: "error", message: GENERIC_ASSIGN_ERROR };
  }
}

export async function submitCancellation(
  assignmentId: string,
  fetchImpl: typeof fetch = fetch
): Promise<CancelResult> {
  try {
    const res = await fetchImpl(`${ASSIGNMENTS_API}/${encodeURIComponent(assignmentId)}/cancel`, {
      method: "POST",
    });
    const body = await readJson(res);
    if (!res.ok) return { kind: "error", message: serverMessage(body, GENERIC_CANCEL_ERROR) };

    const outcome = (body as { outcome?: unknown } | null)?.outcome;
    return outcome === "cancelled" || outcome === "already_cancelled"
      ? { kind: outcome }
      : { kind: "error", message: GENERIC_CANCEL_ERROR };
  } catch {
    return { kind: "error", message: GENERIC_CANCEL_ERROR };
  }
}
