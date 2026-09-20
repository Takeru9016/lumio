/**
 * `sourceKey` is one part of a LearningAssignment's identity:
 * (userId, courseId, source, sourceKey). It is built here, from ids the
 * service has already validated — never accepted from a client.
 *
 * The unique index always includes userId and courseId, so a key only has to
 * be distinct within one learner-and-course pair. That is what makes
 * "a learner has at most one manual assignment per course" hold, without a
 * key that could be mistaken for a global singleton.
 */

/** One manual assignment per learner and course; re-assigning reactivates it. */
export function manualSourceKey(courseId: string): string {
  return `manual:${courseId}`;
}

/** One row per learner and mandatory-training policy. */
export function mandatorySourceKey(mandatoryTrainingId: string): string {
  return `mandatory:${mandatoryTrainingId}`;
}

/**
 * One row per learner, course, role and skill. Role alone would collapse two
 * different skill gaps that the same course closes into one row and lose the
 * second gap's provenance.
 */
export function capabilityGapSourceKey(roleId: string, skillId: string): string {
  return `gap:${roleId}:${skillId}`;
}
