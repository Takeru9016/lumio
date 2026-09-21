import { describe, expect, it } from "vitest";
import { isEnforceablePrerequisite } from "@/lib/domain/course/prerequisites";
import { courseBlockReason, isCourseAvailable } from "@/lib/domain/learning-path/availability";

const STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;

describe("isCourseAvailable", () => {
  it("is exactly: PUBLISHED with a published, non-archived lesson", () => {
    for (const status of STATUSES) {
      for (const hasPublishedLesson of [true, false]) {
        expect(isCourseAvailable({ status, hasPublishedLesson })).toBe(
          status === "PUBLISHED" && hasPublishedLesson
        );
      }
    }
  });

  it("agrees with the prerequisite system's own definition of a course that can be completed", () => {
    for (const status of STATUSES) {
      for (const hasPublishedLesson of [true, false]) {
        expect(isCourseAvailable({ status, hasPublishedLesson })).toBe(
          isEnforceablePrerequisite({ status, hasPublishedLessons: hasPublishedLesson })
        );
      }
    }
  });
});

describe("courseBlockReason", () => {
  const base = { tenantId: "t", status: "PUBLISHED" as const, hasPublishedLesson: true };

  it("is null for a good course", () => {
    expect(courseBlockReason(base, "t")).toBeNull();
  });

  it("names the first thing wrong: tenant, then archived, then draft, then no lesson", () => {
    expect(courseBlockReason({ ...base, tenantId: null }, "t")).toBe("WRONG_TENANT");
    expect(courseBlockReason({ ...base, tenantId: "u", status: "ARCHIVED" }, "t")).toBe(
      "WRONG_TENANT"
    );
    expect(courseBlockReason({ ...base, status: "ARCHIVED", hasPublishedLesson: false }, "t")).toBe(
      "ARCHIVED"
    );
    expect(courseBlockReason({ ...base, status: "DRAFT", hasPublishedLesson: false }, "t")).toBe(
      "NOT_PUBLISHED"
    );
    expect(courseBlockReason({ ...base, hasPublishedLesson: false }, "t")).toBe(
      "NO_PUBLISHED_LESSON"
    );
  });

  it("a path with no tenant matches no course, not even a tenantless one", () => {
    expect(courseBlockReason({ ...base, tenantId: null }, null as never)).toBe("WRONG_TENANT");
    expect(courseBlockReason(base, "")).toBe("WRONG_TENANT");
  });
});
