import type { CourseStatus } from "@/generated/prisma/enums";
import type { PublishBlockReason } from "@/lib/domain/learning-path/types";

/**
 * The few facts about a course that the path rules need, read by whoever loads
 * them (the caller, never this module). `hasPublishedLesson` means at least one
 * published, non-archived lesson: the same test course completion applies.
 */
export type CourseFacts = {
  id: string;
  title: string;
  tenantId: string | null;
  status: CourseStatus;
  hasPublishedLesson: boolean;
};

/**
 * A course a learner can currently take to completion: PUBLISHED, with something
 * to complete. This is the same definition the prerequisite system uses for a
 * prerequisite that still binds (an availability test in this folder keeps the two
 * from drifting apart). It is restated here rather than imported so this module
 * depends on nothing about prerequisites, enrollment or the database.
 */
export function isCourseAvailable(course: {
  status: CourseStatus;
  hasPublishedLesson: boolean;
}): boolean {
  return course.status === "PUBLISHED" && course.hasPublishedLesson;
}

/**
 * The first reason `course` cannot be a member of a published path of
 * `pathTenantId`, or null. Checked in the order an administrator would want to
 * fix them: the wrong tenant (the course does not belong here at all, and a
 * tenantless course or a path with no tenant never matches), then archived, then
 * not published, then nothing to complete.
 */
export function courseBlockReason(
  course: CourseFacts | Omit<CourseFacts, "id" | "title">,
  pathTenantId: string
): PublishBlockReason | null {
  if (!pathTenantId || course.tenantId === null || course.tenantId !== pathTenantId) {
    return "WRONG_TENANT";
  }
  if (course.status === "ARCHIVED") return "ARCHIVED";
  if (course.status !== "PUBLISHED") return "NOT_PUBLISHED";
  if (!course.hasPublishedLesson) return "NO_PUBLISHED_LESSON";
  return null;
}
