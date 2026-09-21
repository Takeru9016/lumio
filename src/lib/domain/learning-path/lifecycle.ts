import { fail, type LearningPathStatus } from "@/lib/domain/learning-path/types";

/**
 * A path's lifecycle is its own, not a copy of a course's:
 *
 *   DRAFT -> PUBLISHED, DRAFT -> ARCHIVED, PUBLISHED -> ARCHIVED, ARCHIVED -> PUBLISHED
 *
 * and nothing else. There is no unpublish (nothing goes back to DRAFT) and no
 * transition to the same status. Coming back from ARCHIVED is a full republish: it
 * is a transition INTO PUBLISHED, so it needs the whole publishability check again.
 */
export const LEARNING_PATH_TRANSITIONS: Readonly<
  Record<LearningPathStatus, readonly LearningPathStatus[]>
> = {
  DRAFT: ["PUBLISHED", "ARCHIVED"],
  PUBLISHED: ["ARCHIVED"],
  ARCHIVED: ["PUBLISHED"],
};

export function canTransition(from: LearningPathStatus, to: LearningPathStatus): boolean {
  return (LEARNING_PATH_TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransition(from: LearningPathStatus, to: LearningPathStatus): void {
  if (!canTransition(from, to)) throw fail.transition();
}

/** Arriving at PUBLISHED, from DRAFT or ARCHIVED, must pass the publishability check. */
export function transitionNeedsPublishability(to: LearningPathStatus): boolean {
  return to === "PUBLISHED";
}

/** An ARCHIVED path is read-only: its metadata and its courses are frozen. */
export function assertPathEditable(status: LearningPathStatus): void {
  if (status === "ARCHIVED") throw fail.pathArchived();
}
