import type { AuthContext } from "@/lib/auth/context";
import { isValidId } from "@/lib/domain/learning-assignment/inputRules";
import {
  LEARNING_PATH_DESCRIPTION_MAX_LENGTH,
  LEARNING_PATH_TITLE_MAX_LENGTH,
} from "@/lib/domain/learning-path/constants";
import { fail } from "@/lib/domain/learning-path/types";

/**
 * Value rules for the untrusted inputs of a learning path. They live in the
 * domain so every caller is protected by the same checks, and so a bad value comes
 * back as INVALID_INPUT instead of surfacing as a database-driver error.
 */

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Whether every character can be stored and shown. NUL and the other control
 * characters are refused; a description may also hold tab, line feed and carriage
 * return for its line breaks, a title may not.
 */
function isStorable(value: string, allowLineBreaks: boolean): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const isLineBreak = code === 0x09 || code === 0x0a || code === 0x0d;
    const isControl = code < 0x20 || code === 0x7f;
    if (isControl && !(allowLineBreaks && isLineBreak)) return false;
  }
  return !LONE_SURROGATE.test(value);
}

export function validateTitle(value: unknown): string {
  if (typeof value !== "string") throw fail.invalid("A title is required");
  const title = value.trim();
  if (title.length === 0 || title.length > LEARNING_PATH_TITLE_MAX_LENGTH) {
    throw fail.invalid(`Title must be between 1 and ${LEARNING_PATH_TITLE_MAX_LENGTH} characters`);
  }
  if (!isStorable(title, false))
    throw fail.invalid("Title contains characters that aren't allowed");
  return title;
}

/** Missing, null, empty and blank all mean "no description". */
export function validateDescription(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw fail.invalid("Invalid description");
  const description = value.trim();
  if (description.length > LEARNING_PATH_DESCRIPTION_MAX_LENGTH) {
    throw fail.invalid(
      `Description must be ${LEARNING_PATH_DESCRIPTION_MAX_LENGTH} characters or fewer`
    );
  }
  if (!isStorable(description, true)) {
    throw fail.invalid("Description contains characters that aren't allowed");
  }
  return description.length === 0 ? null : description;
}

function isPlainBody(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The body may name only `allowed`. Anything else, tenantId, createdById, status,
 * position, id, publishedAt or a made-up field, is refused rather than ignored, so
 * a forged value fails loudly instead of being silently dropped or, worse, used.
 */
function assertOnlyKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw fail.invalid("Unexpected field in the request");
  }
}

export type CreatePathInput = { title: string; description: string | null };
export type UpdatePathInput = { title?: string; description?: string | null };

export function parseCreatePathInput(input: unknown): CreatePathInput {
  if (!isPlainBody(input)) throw fail.invalid("Invalid request");
  assertOnlyKeys(input, ["title", "description"]);
  return { title: validateTitle(input.title), description: validateDescription(input.description) };
}

/** Only the fields that were supplied come back; `description: null` clears it. */
export function parseUpdatePathInput(input: unknown): UpdatePathInput {
  if (!isPlainBody(input)) throw fail.invalid("Invalid request");
  assertOnlyKeys(input, ["title", "description"]);
  const update: UpdatePathInput = {};
  if (input.title !== undefined) update.title = validateTitle(input.title);
  if (input.description !== undefined) update.description = validateDescription(input.description);
  if (Object.keys(update).length === 0) throw fail.invalid("Nothing to update");
  return update;
}

/** The authenticated actor a path is created for: from the session, never the request. */
export type PathActor = { tenantId: string; userId: string };

/**
 * The only people who manage paths are ORG_ADMINs of a tenant. A super admin is
 * not a tenant actor, an instructor owns courses rather than an organisation's
 * paths, and someone with no tenant has nowhere to own one. Fails closed.
 */
export function assertPathManager(ctx: AuthContext): PathActor {
  if (ctx.role !== "ORG_ADMIN" || !ctx.tenantId) throw fail.forbidden();
  return { tenantId: ctx.tenantId, userId: ctx.userId };
}

export type NewLearningPath = {
  tenantId: string;
  createdById: string;
  title: string;
  description: string | null;
  status: "DRAFT";
};

/**
 * What a new path is created with. Tenant and creator come from the authenticated
 * context and the status is always DRAFT; the input can name none of them (a body
 * that tries is INVALID_INPUT). Authorization is decided before the input is read.
 */
export function buildNewPath(ctx: AuthContext, input: unknown): NewLearningPath {
  const actor = assertPathManager(ctx);
  const { title, description } = parseCreatePathInput(input);
  return {
    tenantId: actor.tenantId,
    createdById: actor.userId,
    title,
    description,
    status: "DRAFT",
  };
}

/** Body of "add a course": the course to add and nothing else, in particular no position. */
export function parseAddCourseInput(input: unknown): { courseId: string } {
  if (!isPlainBody(input)) throw fail.invalid("Invalid request");
  assertOnlyKeys(input, ["courseId"]);
  if (!isValidId(input.courseId)) throw fail.invalid("A course is required");
  return { courseId: input.courseId };
}

/**
 * Body of "reorder": the complete ordered list of course ids and nothing else. The
 * list itself is checked against the path's current members by `planReorder`; only
 * its presence is required here. A client never names a position.
 */
export function parseReorderInput(input: unknown): { courseIds: unknown } {
  if (!isPlainBody(input)) throw fail.invalid("Invalid request");
  assertOnlyKeys(input, ["courseIds"]);
  if (!("courseIds" in input))
    throw fail.invalid("Send every course in the path, in the order you want");
  return { courseIds: input.courseIds };
}
