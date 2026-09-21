import type { LearningPathStatus } from "@/generated/prisma/enums";
import { LEARNING_PATH_MAX_COURSES } from "@/lib/domain/learning-path/constants";

export type { LearningPathStatus };

/**
 * Learning path errors (Phase 29.3.0). Each code is a domain concept, independent
 * of how a caller reports it: there is deliberately no HTTP status here, so a route,
 * a job or a script can all map the same codes their own way. Prose never names an
 * id, a tenant, another course or a database message.
 */
export type LearningPathErrorCode =
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "INVALID_TRANSITION"
  | "PATH_ARCHIVED"
  | "COURSE_NOT_FOUND"
  | "COURSE_ARCHIVED"
  | "DUPLICATE"
  | "LIMIT_REACHED"
  | "LAST_COURSE"
  | "PATH_NOT_PUBLISHABLE"
  | "STALE_ORDER";

export class LearningPathError extends Error {
  constructor(
    public code: LearningPathErrorCode,
    message: string
  ) {
    super(message);
    this.name = "LearningPathError";
  }
}

/** Why one course stops a path from being published. */
export type PublishBlockReason =
  | "WRONG_TENANT"
  | "ARCHIVED"
  | "NOT_PUBLISHED"
  | "NO_PUBLISHED_LESSON";

/**
 * What stands between a path and being publishable. For an administrator of the
 * path's tenant only: `title` here is a course title an admin can already see, and
 * it is never part of anything a learner is shown.
 */
export type PublishabilityProblem =
  | { kind: "INVALID_TITLE" }
  | { kind: "NO_COURSES" }
  | { kind: "COURSE"; courseId: string; title: string; reason: PublishBlockReason };

/**
 * PATH_NOT_PUBLISHABLE, carrying the problems so an administrator can be told
 * which courses to fix. The message itself stays prose.
 */
export class PathNotPublishableError extends LearningPathError {
  constructor(public problems: PublishabilityProblem[]) {
    super("PATH_NOT_PUBLISHABLE", "The path can't be published yet");
    this.name = "PathNotPublishableError";
  }
}

export const fail = {
  forbidden: () => new LearningPathError("FORBIDDEN", "Forbidden"),
  notFound: () => new LearningPathError("NOT_FOUND", "Learning path not found"),
  invalid: (message: string) => new LearningPathError("INVALID_INPUT", message),
  transition: () =>
    new LearningPathError("INVALID_TRANSITION", "The path can't move to that status from here"),
  pathArchived: () => new LearningPathError("PATH_ARCHIVED", "Archived paths can't be changed"),
  courseNotFound: () => new LearningPathError("COURSE_NOT_FOUND", "Course not found"),
  courseArchived: () =>
    new LearningPathError("COURSE_ARCHIVED", "Archived courses can't be added to a path"),
  duplicate: () => new LearningPathError("DUPLICATE", "That course is already in the path"),
  limit: () =>
    new LearningPathError(
      "LIMIT_REACHED",
      `A path can have at most ${LEARNING_PATH_MAX_COURSES} courses`
    ),
  lastCourse: () =>
    new LearningPathError("LAST_COURSE", "A published path must keep at least one course"),
  staleOrder: () =>
    new LearningPathError("STALE_ORDER", "The path's courses have changed; reload and try again"),
};
