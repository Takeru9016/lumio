import { describe, expect, it } from "vitest";
import {
  deriveLearnerCourse,
  type LearnerCourseFacts,
  summarizeProgress,
} from "@/lib/domain/learner-path/availability";
import { derivePathProgress } from "@/lib/domain/learning-path/progress";

const LEARNER_TENANT = "tenant-a";

const facts = (overrides: Partial<LearnerCourseFacts> = {}): LearnerCourseFacts => ({
  courseId: "c1",
  slug: "the-slug",
  title: "The Title",
  position: 3,
  tenantId: LEARNER_TENANT,
  status: "PUBLISHED",
  hasPublishedLesson: true,
  completed: false,
  standing: "NONE",
  ...overrides,
});

const derive = (overrides: Partial<LearnerCourseFacts> = {}) =>
  deriveLearnerCourse(LEARNER_TENANT, facts(overrides));

describe("deriveLearnerCourse", () => {
  it("COMPLETED: the learner's enrollment is completed, with the course's navigation fields", () => {
    expect(derive({ completed: true })).toEqual({
      courseId: "c1",
      slug: "the-slug",
      title: "The Title",
      position: 3,
      availability: "COMPLETED",
      prerequisiteState: "NONE",
    });
  });

  it("COMPLETED outranks a course that has since been archived, unpublished or emptied, and an unmet prerequisite", () => {
    for (const overrides of [
      { status: "ARCHIVED" as const },
      { status: "DRAFT" as const },
      { hasPublishedLesson: false },
      { standing: "UNMET" as const },
    ]) {
      expect(derive({ completed: true, ...overrides }).availability).toBe("COMPLETED");
    }
  });

  it("AVAILABLE: published, completable, not completed, no unmet prerequisite", () => {
    for (const standing of ["NONE", "MET"] as const) {
      expect(derive({ standing })).toEqual({
        courseId: "c1",
        slug: "the-slug",
        title: "The Title",
        position: 3,
        availability: "AVAILABLE",
        prerequisiteState: standing,
      });
    }
  });

  it("UNAVAILABLE for an unmet prerequisite, a course with nothing to complete, a draft and an archived course", () => {
    for (const overrides of [
      { standing: "UNMET" as const },
      { hasPublishedLesson: false },
      { status: "DRAFT" as const },
      { status: "ARCHIVED" as const },
    ]) {
      expect(derive(overrides).availability).toBe("UNAVAILABLE");
    }
  });

  it("an UNAVAILABLE course is reduced to its position and prerequisite state: no title, no slug, nothing else", () => {
    const blocked = derive({ standing: "UNMET" });
    const empty = derive({ hasPublishedLesson: false });

    expect(blocked).toEqual({
      courseId: "c1",
      position: 3,
      availability: "UNAVAILABLE",
      prerequisiteState: "UNMET",
    });
    expect(empty).toEqual({
      courseId: "c1",
      position: 3,
      availability: "UNAVAILABLE",
      prerequisiteState: "NONE",
    });
    for (const entry of [blocked, empty]) {
      expect(JSON.stringify(entry)).not.toMatch(/the-slug|The Title/);
    }
  });

  it("a draft or archived course is not even named", () => {
    for (const status of ["DRAFT", "ARCHIVED"] as const) {
      expect(derive({ status })).toEqual({
        position: 3,
        availability: "UNAVAILABLE",
        prerequisiteState: "NONE",
      });
    }
  });

  it("a course of another tenant, or of none, fails closed: UNAVAILABLE, unnamed, NONE, even if completed", () => {
    for (const tenantId of ["tenant-b", null]) {
      for (const completed of [false, true]) {
        const entry = derive({ tenantId, completed, standing: "UNMET" });
        expect(entry).toEqual({
          position: 3,
          availability: "UNAVAILABLE",
          prerequisiteState: "NONE",
        });
        expect(JSON.stringify(entry)).not.toMatch(/c1|the-slug|The Title|tenant/);
      }
    }
  });

  it("position is advice: it never holds a course back", () => {
    expect(derive({ position: 1 }).availability).toBe("AVAILABLE");
    expect(derive({ position: 20 }).availability).toBe("AVAILABLE");
  });

  it("never returns a tenant, a creator or any other field", () => {
    for (const entry of [derive({ completed: true }), derive(), derive({ standing: "UNMET" })]) {
      expect(Object.keys(entry).sort()).not.toContain("tenantId");
      expect(Object.keys(entry).sort()).not.toContain("status");
    }
  });
});

describe("summarizeProgress", () => {
  const states = (completed: number, available: number, unavailable = 0) => [
    ...Array.from({ length: completed }, () => ({ availability: "COMPLETED" as const })),
    ...Array.from({ length: available }, () => ({ availability: "AVAILABLE" as const })),
    ...Array.from({ length: unavailable }, () => ({ availability: "UNAVAILABLE" as const })),
  ];

  it.each([
    [0, 3, 0],
    [1, 3, 25],
    [2, 2, 50],
    [4, 0, 100],
    [1, 2, 33],
    [2, 1, 67],
    [1, 6, 14],
  ])("%i completed and %i available is %i%%", (completed, available, percentage) => {
    expect(summarizeProgress(states(completed, available))).toEqual({
      completed,
      available,
      percentage,
    });
  });

  it("nothing to complete is null, never NaN, 0 or 100", () => {
    expect(summarizeProgress([])).toEqual({ completed: 0, available: 0, percentage: null });
    expect(summarizeProgress(states(0, 0, 4))).toEqual({
      completed: 0,
      available: 0,
      percentage: null,
    });
  });

  it("unavailable courses are not in the denominator", () => {
    expect(summarizeProgress(states(1, 1, 5)).percentage).toBe(50);
    expect(summarizeProgress(states(2, 0, 3)).percentage).toBe(100);
    expect(summarizeProgress(states(0, 2, 7)).percentage).toBe(0);
  });

  it("agrees with the 29.3.0 path progress helper when no prerequisite is involved", () => {
    const enrollments = ["COMPLETED", "ACTIVE", null, "REFUNDED"] as const;
    const members = enrollments.map((enrollmentStatus, i) => ({
      courseId: `c${i}`,
      status: "PUBLISHED" as const,
      hasPublishedLesson: i !== 2,
      enrollmentStatus,
    }));
    const expected = derivePathProgress(members);

    const mine = summarizeProgress(
      members.map((m, i) =>
        deriveLearnerCourse(LEARNER_TENANT, {
          ...facts({ courseId: m.courseId, position: i + 1 }),
          hasPublishedLesson: m.hasPublishedLesson,
          completed: m.enrollmentStatus === "COMPLETED",
        })
      )
    );

    expect(mine.completed).toBe(expected.completed);
    expect(mine.completed + mine.available).toBe(expected.total);
    expect(mine.percentage).toBe(expected.percent);
  });
});
