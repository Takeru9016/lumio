import { describe, expect, it } from "vitest";

import type { LearnerPathCourse } from "@/lib/domain/learner-path/availability";
import type { LearnerPathListItem } from "@/lib/learner-path-client";
import {
  courseHref,
  pathCta,
  pathHref,
  presentCourse,
  presentPathCard,
  presentProgress,
} from "@/lib/learner-path-view";

const item = (over: Partial<LearnerPathListItem> = {}): LearnerPathListItem => ({
  id: "p1",
  title: "Leadership",
  description: "Build capability.",
  status: "PUBLISHED",
  publishedAt: "2026-09-01T00:00:00.000Z",
  courseCount: 5,
  progress: { completed: 2, available: 3, percentage: 40 },
  ...over,
});

describe("presentProgress", () => {
  it("words the server's counts and carries its percentage unchanged", () => {
    expect(presentProgress({ completed: 2, available: 3, percentage: 40 })).toEqual({
      kind: "measured",
      percent: 40,
      summary: "2 of 5 courses completed",
      completed: 2,
      available: 3,
    });
  });

  it("does not turn a null percentage into 0%, and does not claim the learner has not started", () => {
    const view = presentProgress({ completed: 0, available: 0, percentage: null });
    expect(view).toEqual({ kind: "unmeasured", summary: "No courses are open to you yet" });
    expect(JSON.stringify(view)).not.toMatch(/0%|percent|Not started/);
  });

  it("keeps a real 0% and a real 100%", () => {
    expect(presentProgress({ completed: 0, available: 2, percentage: 0 })).toMatchObject({
      kind: "measured",
      percent: 0,
      summary: "0 of 2 courses completed",
    });
    expect(presentProgress({ completed: 1, available: 0, percentage: 100 })).toMatchObject({
      percent: 100,
      summary: "1 of 1 course completed",
    });
  });
});

describe("pathCta", () => {
  it.each([
    [{ completed: 0, available: 3, percentage: 0 }, "View path"],
    [{ completed: 0, available: 0, percentage: null }, "View path"],
    [{ completed: 2, available: 1, percentage: 67 }, "Continue"],
    [{ completed: 3, available: 0, percentage: 100 }, "Review path"],
  ])("%j is %s", (progress, label) => {
    expect(pathCta(progress)).toBe(label);
  });
});

describe("presentPathCard", () => {
  it("links to the path and counts its courses from the API's count", () => {
    expect(presentPathCard(item())).toMatchObject({
      href: "/paths/p1",
      title: "Leadership",
      courseCountLabel: "5 courses",
      ctaLabel: "Continue",
    });
    expect(presentPathCard(item({ courseCount: 1 })).courseCountLabel).toBe("1 course");
  });

  it("treats a blank description as none", () => {
    expect(presentPathCard(item({ description: "   " })).description).toBeNull();
    expect(presentPathCard(item({ description: null })).description).toBeNull();
  });

  it("encodes ids in links", () => {
    expect(pathHref("a/b c")).toBe("/paths/a%2Fb%20c");
    expect(courseHref("intro to sql")).toBe("/courses/intro%20to%20sql");
  });
});

describe("presentCourse", () => {
  const available: LearnerPathCourse = {
    courseId: "c1",
    slug: "sql-basics",
    title: "SQL Basics",
    position: 1,
    availability: "AVAILABLE",
    prerequisiteState: "NONE",
  };

  it("names an available course and links it by the existing slug route", () => {
    expect(presentCourse(available)).toMatchObject({
      key: 1,
      positionLabel: "01",
      availability: "AVAILABLE",
      availabilityLabel: "Available",
      title: "SQL Basics",
      href: "/courses/sql-basics",
      ctaLabel: "Open course",
      prerequisiteLabel: "No prerequisites",
    });
  });

  it("offers a completed course as a review, not a start", () => {
    const view = presentCourse({
      ...available,
      availability: "COMPLETED",
      prerequisiteState: "MET",
    });
    expect(view).toMatchObject({
      availabilityLabel: "Completed",
      ctaLabel: "Review course",
      prerequisiteLabel: "Prerequisites complete",
    });
  });

  it.each([
    ["UNMET", "Prerequisite required"],
    ["MET", "Prerequisites complete"],
    ["NONE", null],
  ] as const)(
    "draws an unavailable course with prerequisite %s from position and state alone",
    (prerequisiteState, label) => {
      const view = presentCourse({
        courseId: "secret-id",
        position: 3,
        availability: "UNAVAILABLE",
        prerequisiteState,
      });
      expect(view).toEqual({
        key: 3,
        positionLabel: "03",
        availability: "UNAVAILABLE",
        availabilityLabel: "Unavailable",
        title: null,
        href: null,
        ctaLabel: null,
        prerequisiteLabel: label,
        subject: "Course 3",
      });
      expect(JSON.stringify(view)).not.toContain("secret-id");
    }
  );

  it("never shows the raw prerequisite enum", () => {
    for (const state of ["NONE", "MET", "UNMET"] as const) {
      const view = presentCourse({ ...available, prerequisiteState: state });
      expect(view.prerequisiteLabel).not.toMatch(/^(NONE|MET|UNMET)$/);
    }
  });
});
