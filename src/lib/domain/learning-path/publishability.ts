import { type CourseFacts, courseBlockReason } from "@/lib/domain/learning-path/availability";
import { LEARNING_PATH_TITLE_MAX_LENGTH } from "@/lib/domain/learning-path/constants";
import {
  PathNotPublishableError,
  type PublishabilityProblem,
} from "@/lib/domain/learning-path/types";

export type PublishabilityInput = {
  title: string;
  /** The path's tenant, from the path row itself. */
  tenantId: string;
  /** The members, in path order. */
  courses: readonly CourseFacts[];
};

/** The problems with `courses` alone, in path order. Empty when every member is good. */
export function courseProblems(
  tenantId: string,
  courses: readonly CourseFacts[]
): PublishabilityProblem[] {
  return courses.flatMap((course): PublishabilityProblem[] => {
    const reason = courseBlockReason(course, tenantId);
    return reason === null
      ? []
      : [{ kind: "COURSE", courseId: course.id, title: course.title, reason }];
  });
}

/**
 * The publish contract: a valid title, at least one course, and every member of
 * the path's own tenant, PUBLISHED, and with a published, non-archived lesson.
 *
 * Pure. The publish operation itself must run this on facts it read while holding
 * the path's lock; nothing here reads or writes anything. The problems name the
 * blocking courses so an administrator can fix them, and are not for learners.
 */
export function assessPublishability(input: PublishabilityInput): {
  publishable: boolean;
  problems: PublishabilityProblem[];
} {
  const problems: PublishabilityProblem[] = [];
  const title = input.title?.trim() ?? "";
  if (title.length === 0 || title.length > LEARNING_PATH_TITLE_MAX_LENGTH) {
    problems.push({ kind: "INVALID_TITLE" });
  }
  if (input.courses.length === 0) problems.push({ kind: "NO_COURSES" });
  problems.push(...courseProblems(input.tenantId, input.courses));
  return { publishable: problems.length === 0, problems };
}

export function assertPublishable(input: PublishabilityInput): void {
  const { publishable, problems } = assessPublishability(input);
  if (!publishable) throw new PathNotPublishableError(problems);
}
