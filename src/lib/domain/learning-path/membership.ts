import { type CourseFacts, courseBlockReason } from "@/lib/domain/learning-path/availability";
import { LEARNING_PATH_MAX_COURSES } from "@/lib/domain/learning-path/constants";
import { assertPathEditable } from "@/lib/domain/learning-path/lifecycle";
import { courseProblems } from "@/lib/domain/learning-path/publishability";
import {
  fail,
  type LearningPathStatus,
  PathNotPublishableError,
} from "@/lib/domain/learning-path/types";

/** A path as the membership rules see it; `members` is who is in it now. */
export type PathFacts<M> = {
  tenantId: string;
  status: LearningPathStatus;
  members: readonly M[];
};

/**
 * Whether `course` may join `path`, deciding in this order:
 *
 *   1. the path has a tenant, and is not ARCHIVED (both are about the path, which
 *      the caller already knows)
 *   2. the course exists and belongs to the path's own, non-null tenant. Missing,
 *      tenantless and foreign are one COURSE_NOT_FOUND, so a course of another
 *      tenant cannot be told apart from one that does not exist
 *   3. it is not ARCHIVED (COURSE_ARCHIVED, only ever said about a same-tenant course)
 *   4. it is not already a member (DUPLICATE)
 *   5. a PUBLISHED path takes only a course that keeps it publishable
 *      (PATH_NOT_PUBLISHABLE, naming why); a DRAFT path takes DRAFT and PUBLISHED
 *   6. the path has room (LIMIT_REACHED at LEARNING_PATH_MAX_COURSES)
 *
 * Pure: the caller supplies the facts it read, and nothing about prerequisites,
 * enrollment or position is consulted. The operation that acts on the answer must
 * decide it while holding the path's lock.
 */
export function assertCourseMayJoin(input: {
  path: PathFacts<{ id: string }>;
  course: CourseFacts | null;
}): void {
  const { path, course } = input;
  if (!path.tenantId) throw fail.notFound();
  assertPathEditable(path.status);

  if (!course || course.tenantId === null || course.tenantId !== path.tenantId) {
    throw fail.courseNotFound();
  }
  if (course.status === "ARCHIVED") throw fail.courseArchived();
  if (path.members.some((member) => member.id === course.id)) throw fail.duplicate();

  if (path.status === "PUBLISHED") {
    const reason = courseBlockReason(course, path.tenantId);
    if (reason !== null) {
      throw new PathNotPublishableError([
        { kind: "COURSE", courseId: course.id, title: course.title, reason },
      ]);
    }
  }
  if (path.members.length >= LEARNING_PATH_MAX_COURSES) throw fail.limit();
}

/**
 * Whether `courseId` may leave `path`.
 *
 * A DRAFT path lets any member go, the last included. An ARCHIVED path lets none.
 * A PUBLISHED path must stay publishable, so:
 *
 *   - removing its last course is LAST_COURSE
 *   - if what remains would have a member that blocks publishing, the removal is
 *     PATH_NOT_PUBLISHABLE (naming it), UNLESS the course being removed is itself
 *     one of the blockers: getting a broken course out can only improve the path,
 *     and refusing it would leave an administrator unable to repair a path whose
 *     courses were archived after it was published
 *
 * Removing a course from a path of healthy courses therefore always succeeds
 * (a subset of good courses is good) except when it is the last one. Not a
 * member is COURSE_NOT_FOUND. Pure, like assertCourseMayJoin.
 */
export function assertCourseMayLeave(input: {
  path: PathFacts<CourseFacts>;
  courseId: string;
}): void {
  const { path, courseId } = input;
  if (!path.tenantId) throw fail.notFound();
  assertPathEditable(path.status);

  const leaving = path.members.find((member) => member.id === courseId);
  if (!leaving) throw fail.courseNotFound();
  if (path.status !== "PUBLISHED") return;

  const remaining = path.members.filter((member) => member.id !== courseId);
  if (remaining.length === 0) throw fail.lastCourse();

  const problems = courseProblems(path.tenantId, remaining);
  const leavingIsBroken = courseBlockReason(leaving, path.tenantId) !== null;
  if (problems.length > 0 && !leavingIsBroken) throw new PathNotPublishableError(problems);
}
