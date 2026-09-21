import { isValidId } from "@/lib/domain/learning-assignment/inputRules";
import { fail } from "@/lib/domain/learning-path/types";

/**
 * Path order is advisory: it is what the path recommends, and nothing in
 * enrollment, payment or assignment reads it. As the domain writes it, `position`
 * is exactly 1..n. Readers still tolerate gaps and ties (a deleted course leaves a
 * gap until the next write renumbers), and the client is never trusted for a
 * position: it names courses, and the server assigns the numbers.
 */

export type PathMember = { courseId: string; position: number };

/** Where a newly added course goes: at the end, one past the largest position held. */
export function nextPosition(positions: readonly number[]): number {
  return positions.length === 0 ? 1 : Math.max(...positions) + 1;
}

/** Path order: by position, with course id breaking a tie so the answer is deterministic. */
export function sortMembers<T extends PathMember>(members: readonly T[]): T[] {
  return [...members].sort(
    (a, b) =>
      a.position - b.position || (a.courseId < b.courseId ? -1 : a.courseId > b.courseId ? 1 : 0)
  );
}

/** The same members in the same order, numbered exactly 1..n. */
export function renumber(members: readonly PathMember[]): PathMember[] {
  return sortMembers(members).map((member, index) => ({
    courseId: member.courseId,
    position: index + 1,
  }));
}

/** What is left after `courseId` leaves, renumbered to 1..n-1. */
export function positionsAfterRemoval(
  members: readonly PathMember[],
  courseId: string
): PathMember[] {
  return renumber(members.filter((member) => member.courseId !== courseId));
}

/**
 * Turns a client's complete ordered list of course ids into the positions to write,
 * or refuses it.
 *
 * The list is malformed, INVALID_INPUT, when it is not an array of ids, is empty,
 * or repeats a course: those are wrong whatever the path holds. It is STALE_ORDER
 * when it is well formed but is not exactly the path's current set, whether a
 * course is missing or an unknown one is named: the client is looking at a path
 * that has since changed (or names a course that was never in it, which it cannot
 * be told apart from, so nothing is disclosed). Malformed is decided first.
 * The result is 1..n in the requested order; the current order is irrelevant.
 */
export function planReorder(
  currentCourseIds: readonly string[],
  requestedCourseIds: unknown
): PathMember[] {
  if (!Array.isArray(requestedCourseIds) || requestedCourseIds.length === 0) {
    throw fail.invalid("Send every course in the path, in the order you want");
  }
  if (!requestedCourseIds.every(isValidId)) throw fail.invalid("Invalid course id");
  const requested: string[] = requestedCourseIds;
  if (new Set(requested).size !== requested.length) {
    throw fail.invalid("Each course can appear only once");
  }

  const current = new Set(currentCourseIds);
  if (requested.length !== current.size || !requested.every((id) => current.has(id))) {
    throw fail.staleOrder();
  }
  return requested.map((courseId, index) => ({ courseId, position: index + 1 }));
}
