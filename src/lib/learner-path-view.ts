import type {
  LearnerCourseAvailability,
  LearnerPathCourse,
  LearnerPrerequisiteState,
} from "@/lib/domain/learner-path/availability";
import type { LearnerPath, LearnerPathListItem, LearnerProgress } from "@/lib/learner-path-client";

/**
 * How a learner's learning paths are worded. Everything here is presentation of
 * what the server already decided: availability, prerequisite state and progress
 * arrive derived, and none of it is recomputed. An unavailable course arrives
 * redacted and stays that way: this module has no title, slug or reason to show
 * for it because the API never sent one.
 */

export const PATHS_PATH = "/paths";

export const pathHref = (pathId: string) => `${PATHS_PATH}/${encodeURIComponent(pathId)}`;

/** The existing course route: the catalogue and the learner's courses both link by slug. */
export const courseHref = (slug: string) => `/courses/${encodeURIComponent(slug)}`;

export const AVAILABILITY_LABELS: Record<LearnerCourseAvailability, string> = {
  COMPLETED: "Completed",
  AVAILABLE: "Available",
  UNAVAILABLE: "Unavailable",
};

export const PREREQUISITE_LABELS: Record<LearnerPrerequisiteState, string> = {
  NONE: "No prerequisites",
  MET: "Prerequisites complete",
  UNMET: "Prerequisite required",
};

export function pluralCourses(count: number): string {
  return `${count} ${count === 1 ? "course" : "courses"}`;
}

export type ProgressView =
  | {
      kind: "measured";
      percent: number;
      /** "2 of 5 courses completed" */
      summary: string;
      completed: number;
      available: number;
    }
  | {
      kind: "unmeasured";
      /** There is nothing completed or open to measure yet. */
      summary: string;
    };

/**
 * `percentage: null` means the server had nothing to measure, and the screen says
 * exactly that instead of drawing 0%. The sentence never claims the learner has or
 * has not started: null says only that no course is open to them right now.
 */
export function presentProgress(progress: LearnerProgress): ProgressView {
  if (progress.percentage === null) {
    return { kind: "unmeasured", summary: "No courses are open to you yet" };
  }
  const total = progress.completed + progress.available;
  return {
    kind: "measured",
    percent: progress.percentage,
    summary: `${progress.completed} of ${pluralCourses(total)} completed`,
    completed: progress.completed,
    available: progress.available,
  };
}

/** The label of a path card's link, from the counts the server sent. */
export function pathCta(progress: LearnerProgress): string {
  if (progress.percentage === 100) return "Review path";
  if (progress.completed > 0) return "Continue";
  return "View path";
}

export type PathCardView = {
  id: string;
  href: string;
  title: string;
  description: string | null;
  courseCountLabel: string;
  progress: ProgressView;
  ctaLabel: string;
};

export function presentPathCard(item: LearnerPathListItem): PathCardView {
  return {
    id: item.id,
    href: pathHref(item.id),
    title: item.title,
    description: item.description?.trim() ? item.description : null,
    courseCountLabel: pluralCourses(item.courseCount),
    progress: presentProgress(item.progress),
    ctaLabel: pathCta(item.progress),
  };
}

export type CourseRowView = {
  /** Path position is the only stable key: an unavailable course has no id. */
  key: number;
  positionLabel: string;
  availability: LearnerCourseAvailability;
  availabilityLabel: string;
  /** Present only for a course the server named. */
  title: string | null;
  /** Present only when the learner can open the course. */
  href: string | null;
  ctaLabel: string | null;
  prerequisiteLabel: string | null;
  /** Spoken name for the row, safe for a redacted course too. */
  subject: string;
};

const positionLabel = (position: number) => String(position).padStart(2, "0");

/**
 * An unavailable course is described only by its position and by the prerequisite
 * state the API gave. `NONE` on an unavailable course says nothing about why, so it
 * gets no reason at all rather than an invented one.
 */
export function presentCourse(course: LearnerPathCourse): CourseRowView {
  const base = {
    key: course.position,
    positionLabel: positionLabel(course.position),
    availability: course.availability,
    availabilityLabel: AVAILABILITY_LABELS[course.availability],
  };

  if (course.availability === "UNAVAILABLE") {
    return {
      ...base,
      title: null,
      href: null,
      ctaLabel: null,
      prerequisiteLabel:
        course.prerequisiteState === "NONE" ? null : PREREQUISITE_LABELS[course.prerequisiteState],
      subject: `Course ${course.position}`,
    };
  }

  return {
    ...base,
    title: course.title,
    href: courseHref(course.slug),
    // The API says whether a course can be taken, not whether it was begun, so the
    // link never claims "Start" or "Continue" for it.
    ctaLabel: course.availability === "COMPLETED" ? "Review course" : "Open course",
    prerequisiteLabel: PREREQUISITE_LABELS[course.prerequisiteState],
    subject: course.title,
  };
}

export function presentPathCourses(path: LearnerPath): CourseRowView[] {
  return path.courses.map(presentCourse);
}
