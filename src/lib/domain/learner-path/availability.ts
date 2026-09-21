import type { CourseStatus } from "@/generated/prisma/enums";
import type { PrerequisiteStanding } from "@/lib/domain/course/prerequisites";
import { isCourseAvailable } from "@/lib/domain/learning-path/availability";

/**
 * What a learner is told about each course of a path, derived from current data
 * every time it is read. Nothing here is stored: no availability, no progress and no
 * path completion is ever written.
 *
 * - COMPLETED: the learner's own Enrollment on the course is COMPLETED. It outranks
 *   everything else, so a course completed and later archived stays completed.
 * - AVAILABLE: not completed, the course is PUBLISHED with a published, non-archived
 *   lesson, and none of its enforceable prerequisites is unmet.
 * - UNAVAILABLE: anything else, including a course of another tenant or of no tenant
 *   (which fails closed, whatever the learner's enrollments say).
 *
 * Position is advice about order and never an availability rule: a course listed
 * after another is not held back by it. Prerequisites are the only ordering rule.
 */
export type LearnerCourseAvailability = "COMPLETED" | "AVAILABLE" | "UNAVAILABLE";

export type LearnerPrerequisiteState = PrerequisiteStanding;

export type LearnerPathCourse =
  | {
      courseId: string;
      slug: string;
      title: string;
      position: number;
      availability: "COMPLETED" | "AVAILABLE";
      prerequisiteState: LearnerPrerequisiteState;
    }
  | {
      /** Only for a live course of the learner's own tenant; never for a draft, an archived or a foreign one. */
      courseId?: string;
      position: number;
      availability: "UNAVAILABLE";
      prerequisiteState: LearnerPrerequisiteState;
    };

/** One member of a path with everything the derivation needs, read by the caller. */
export type LearnerCourseFacts = {
  courseId: string;
  slug: string;
  title: string;
  position: number;
  tenantId: string | null;
  status: CourseStatus;
  /** At least one published, non-archived lesson. */
  hasPublishedLesson: boolean;
  /** The learner's own Enrollment on it is COMPLETED. */
  completed: boolean;
  standing: PrerequisiteStanding;
};

/**
 * The learner-safe entry for one course.
 *
 * An UNAVAILABLE course is reduced to its position and its prerequisite state: no
 * title, no slug, no reason. Its id is included only when the course is a live
 * (PUBLISHED) course of the learner's own tenant that is merely blocked or empty; a
 * draft, an archived or a foreign course is not even named. A course of another
 * tenant (or of none) is reported as UNAVAILABLE with a prerequisite state of NONE,
 * as the prerequisite evaluator does for a course outside the learner's tenant.
 */
export function deriveLearnerCourse(
  learnerTenantId: string,
  m: LearnerCourseFacts
): LearnerPathCourse {
  if (m.tenantId === null || m.tenantId !== learnerTenantId) {
    return { position: m.position, availability: "UNAVAILABLE", prerequisiteState: "NONE" };
  }

  const visible = {
    courseId: m.courseId,
    slug: m.slug,
    title: m.title,
    position: m.position,
    prerequisiteState: m.standing,
  };
  if (m.completed) return { ...visible, availability: "COMPLETED" };
  if (isCourseAvailable(m) && m.standing !== "UNMET")
    return { ...visible, availability: "AVAILABLE" };

  return {
    ...(m.status === "PUBLISHED" ? { courseId: m.courseId } : {}),
    position: m.position,
    availability: "UNAVAILABLE",
    prerequisiteState: m.standing,
  };
}

export type LearnerPathProgress = {
  completed: number;
  available: number;
  /** Whole percent of completed / (completed + available), or null when that is 0. */
  percentage: number | null;
};

/**
 * COMPLETED over COMPLETED + AVAILABLE. UNAVAILABLE courses are left out of the
 * denominator, so a course the learner cannot take today neither holds them back
 * nor counts for them. With nothing to complete the percentage is null, never 0 or
 * 100. Rounded to a whole number like every other percentage in the product.
 */
export function summarizeProgress(
  courses: readonly { availability: LearnerCourseAvailability }[]
): LearnerPathProgress {
  const completed = courses.filter((c) => c.availability === "COMPLETED").length;
  const available = courses.filter((c) => c.availability === "AVAILABLE").length;
  const total = completed + available;
  return {
    completed,
    available,
    percentage: total === 0 ? null : Math.round((completed / total) * 100),
  };
}
