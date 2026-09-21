import type { CourseFacts } from "@/lib/domain/learning-path/availability";

export const TENANT = "tenant-a";

let seq = 0;

/** A published, completable course of TENANT unless overridden. */
export function courseFacts(overrides: Partial<CourseFacts> = {}): CourseFacts {
  seq += 1;
  return {
    id: `course-${seq}`,
    title: `Course ${seq}`,
    tenantId: TENANT,
    status: "PUBLISHED",
    hasPublishedLesson: true,
    ...overrides,
  };
}

export function manyCourses(count: number, overrides: Partial<CourseFacts> = {}): CourseFacts[] {
  return Array.from({ length: count }, () => courseFacts(overrides));
}
