import { LearningPathStatus } from "@/generated/prisma/enums";
import { isValidId } from "@/lib/domain/learning-assignment/inputRules";
import {
  LEARNING_PATH_PAGE_MAX,
  LEARNING_PATH_PAGE_SIZE,
} from "@/lib/domain/learning-path/constants";
import { fail } from "@/lib/domain/learning-path/types";

/**
 * How the admin list of paths is asked for and paged. Pure: it turns the raw,
 * untrusted query values into what the read takes, or refuses them as INVALID_INPUT.
 *
 * The list is ordered newest first by (createdAt, id), both immutable, so a keyset
 * cursor stays stable however paths change status between pages.
 */
export type PathCursor = { createdAt: Date; id: string };

export function encodeCursor(row: PathCursor): string {
  return Buffer.from(
    JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id }),
    "utf8"
  ).toString("base64");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Anything that is not a cursor this module issued is INVALID_INPUT. */
export function decodeCursor(raw: string): PathCursor {
  const invalid = () => fail.invalid("Invalid cursor");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    throw invalid();
  }
  if (!isRecord(parsed) || typeof parsed.createdAt !== "string" || !isValidId(parsed.id)) {
    throw invalid();
  }
  const createdAt = new Date(parsed.createdAt);
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== parsed.createdAt) {
    throw invalid();
  }
  return { createdAt, id: parsed.id };
}

export type ListPathsQuery = {
  status: LearningPathStatus | null;
  cursor: PathCursor | null;
  limit: number;
};

const absent = (value: unknown) => value === undefined || value === null || value === "";

/**
 * Absent, null and empty mean "not given". A status must name one of the three
 * lifecycle statuses (any case); a limit must be a whole number of at least 1 and
 * is capped at LEARNING_PATH_PAGE_MAX rather than refused, so a big page size is
 * bounded without breaking the client that asked for it.
 */
export function parseListQuery(raw: {
  status?: unknown;
  cursor?: unknown;
  limit?: unknown;
}): ListPathsQuery {
  let status: LearningPathStatus | null = null;
  if (!absent(raw.status)) {
    const wanted = typeof raw.status === "string" ? raw.status.trim().toUpperCase() : "";
    const match = Object.values(LearningPathStatus).find((s) => s === wanted);
    if (!match) throw fail.invalid("Unknown status filter");
    status = match;
  }

  let cursor: PathCursor | null = null;
  if (!absent(raw.cursor)) {
    if (typeof raw.cursor !== "string") throw fail.invalid("Invalid cursor");
    cursor = decodeCursor(raw.cursor);
  }

  let limit = LEARNING_PATH_PAGE_SIZE;
  if (!absent(raw.limit)) {
    const wholeNumber =
      typeof raw.limit === "number"
        ? Number.isInteger(raw.limit)
        : typeof raw.limit === "string" && /^\d{1,9}$/.test(raw.limit);
    const requested = wholeNumber ? Number(raw.limit) : Number.NaN;
    if (!(requested >= 1)) throw fail.invalid("Limit must be a whole number of at least 1");
    limit = Math.min(requested, LEARNING_PATH_PAGE_MAX);
  }
  return { status, cursor, limit };
}
