/**
 * Value rules for the untrusted inputs of the assignment domain. They live in
 * the domain so every caller — a route today, a bulk action or a cron
 * tomorrow — is protected by the same checks, and so a bad value comes back
 * as INVALID_INPUT instead of surfacing as a database-driver error.
 *
 * These are deliberately not a business rule about *which* due dates are
 * acceptable (a past date is still allowed; see the L-4 note in the Phase
 * 28.3 report). They only reject values the platform cannot store or that
 * make no sense.
 */

export const MAX_NOTE_LENGTH = 500;

const MAX_ID_LENGTH = 128;
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Lumio ids are cuids, but tests and legacy rows use readable ids too, so the
 * rule is a charset and length bound rather than a cuid format check. It keeps
 * NUL bytes and oversized strings away from the query layer.
 */
export function isValidId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    ID_PATTERN.test(value)
  );
}

const MIN_DUE_DATE_MS = Date.UTC(1970, 0, 1);
const MAX_DUE_DATE_MS = Date.UTC(2100, 11, 31, 23, 59, 59, 999);

/**
 * A real Date inside a sane window. The window exists because a Date at the
 * edge of JavaScript's range is "valid" to JS but is rejected by Postgres
 * after the transaction has started.
 */
export function isValidDueDate(value: unknown): value is Date {
  if (!(value instanceof Date)) return false;
  const ms = value.getTime();
  return Number.isFinite(ms) && ms >= MIN_DUE_DATE_MS && ms <= MAX_DUE_DATE_MS;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * The note is stored inside a JSONB snapshot. Postgres rejects a NUL
 * character and a lone surrogate there, so both are refused up front. Tab,
 * line feed and carriage return stay allowed for multi-line notes.
 */
export function isValidNote(value: string): boolean {
  if (value.length > MAX_NOTE_LENGTH) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const isControl = code < 0x20 ? code !== 0x09 && code !== 0x0a && code !== 0x0d : code === 0x7f;
    if (isControl) return false;
  }
  return !LONE_SURROGATE.test(value);
}
