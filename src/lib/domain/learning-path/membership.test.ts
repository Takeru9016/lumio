import { describe, expect, it } from "vitest";
import { courseFacts, manyCourses, TENANT } from "@/lib/domain/learning-path/__test__/facts";
import { LEARNING_PATH_MAX_COURSES } from "@/lib/domain/learning-path/constants";
import { assertCourseMayJoin, assertCourseMayLeave } from "@/lib/domain/learning-path/membership";
import {
  LearningPathError,
  type LearningPathStatus,
  PathNotPublishableError,
} from "@/lib/domain/learning-path/types";

function fail(fn: () => unknown): LearningPathError | null {
  try {
    fn();
  } catch (err) {
    if (err instanceof LearningPathError) return err;
    throw err;
  }
  return null;
}
const codeOf = (fn: () => unknown) => fail(fn)?.code ?? "OK";

const path = (
  status: LearningPathStatus,
  members: { id: string }[] = [],
  tenantId: string = TENANT
) => ({ tenantId, status, members });

describe("assertCourseMayJoin — eligibility", () => {
  it("accepts a same-tenant published course", () => {
    expect(codeOf(() => assertCourseMayJoin({ path: path("DRAFT"), course: courseFacts() }))).toBe(
      "OK"
    );
  });

  it("a missing course is COURSE_NOT_FOUND", () => {
    expect(codeOf(() => assertCourseMayJoin({ path: path("DRAFT"), course: null }))).toBe(
      "COURSE_NOT_FOUND"
    );
  });

  it("a tenantless course is COURSE_NOT_FOUND", () => {
    const course = courseFacts({ tenantId: null });

    expect(codeOf(() => assertCourseMayJoin({ path: path("DRAFT"), course }))).toBe(
      "COURSE_NOT_FOUND"
    );
  });

  it("another tenant's course is COURSE_NOT_FOUND, with the same error as a missing one", () => {
    const foreign = fail(() =>
      assertCourseMayJoin({ path: path("DRAFT"), course: courseFacts({ tenantId: "tenant-b" }) })
    );
    const missing = fail(() => assertCourseMayJoin({ path: path("DRAFT"), course: null }));

    expect(foreign?.code).toBe("COURSE_NOT_FOUND");
    expect(foreign?.message).toBe(missing?.message);
    expect(foreign?.message).not.toMatch(/tenant|exist|another/i);
  });

  it("a foreign or tenantless ARCHIVED course is still COURSE_NOT_FOUND, never COURSE_ARCHIVED", () => {
    for (const tenantId of [null, "tenant-b"]) {
      const course = courseFacts({ tenantId, status: "ARCHIVED" });
      expect(codeOf(() => assertCourseMayJoin({ path: path("DRAFT"), course }))).toBe(
        "COURSE_NOT_FOUND"
      );
    }
  });

  it("a same-tenant ARCHIVED course is COURSE_ARCHIVED", () => {
    const course = courseFacts({ status: "ARCHIVED" });

    expect(codeOf(() => assertCourseMayJoin({ path: path("DRAFT"), course }))).toBe(
      "COURSE_ARCHIVED"
    );
    expect(codeOf(() => assertCourseMayJoin({ path: path("PUBLISHED"), course }))).toBe(
      "COURSE_ARCHIVED"
    );
  });

  it("a course already in the path is DUPLICATE", () => {
    const course = courseFacts();

    expect(codeOf(() => assertCourseMayJoin({ path: path("DRAFT", [course]), course }))).toBe(
      "DUPLICATE"
    );
  });

  it("a member that is now archived is COURSE_ARCHIVED before DUPLICATE", () => {
    const course = courseFacts({ status: "ARCHIVED" });

    expect(codeOf(() => assertCourseMayJoin({ path: path("DRAFT", [course]), course }))).toBe(
      "COURSE_ARCHIVED"
    );
  });

  it("an ARCHIVED path takes nothing, before anything about the course is decided", () => {
    expect(
      codeOf(() => assertCourseMayJoin({ path: path("ARCHIVED"), course: courseFacts() }))
    ).toBe("PATH_ARCHIVED");
    expect(codeOf(() => assertCourseMayJoin({ path: path("ARCHIVED"), course: null }))).toBe(
      "PATH_ARCHIVED"
    );
  });

  it("a path with no tenant is refused outright", () => {
    expect(
      codeOf(() =>
        assertCourseMayJoin({
          path: { tenantId: null as never, status: "DRAFT", members: [] },
          course: courseFacts({ tenantId: null }),
        })
      )
    ).toBe("NOT_FOUND");
  });
});

describe("assertCourseMayJoin — limits", () => {
  it.each([0, 1, 19])("a path with %s courses can take one more", (count) => {
    const members = manyCourses(count);

    expect(
      codeOf(() => assertCourseMayJoin({ path: path("DRAFT", members), course: courseFacts() }))
    ).toBe("OK");
  });

  it("a path with 20 courses is full: the 21st is LIMIT_REACHED", () => {
    const members = manyCourses(LEARNING_PATH_MAX_COURSES);

    expect(
      codeOf(() => assertCourseMayJoin({ path: path("DRAFT", members), course: courseFacts() }))
    ).toBe("LIMIT_REACHED");
    expect(
      codeOf(() => assertCourseMayJoin({ path: path("PUBLISHED", members), course: courseFacts() }))
    ).toBe("LIMIT_REACHED");
  });

  it("a duplicate in a full path is reported as DUPLICATE", () => {
    const members = manyCourses(LEARNING_PATH_MAX_COURSES);

    expect(
      codeOf(() => assertCourseMayJoin({ path: path("DRAFT", members), course: members[3] }))
    ).toBe("DUPLICATE");
  });
});

describe("assertCourseMayJoin — draft versus published paths", () => {
  it("a DRAFT path takes DRAFT and PUBLISHED courses", () => {
    for (const status of ["DRAFT", "PUBLISHED"] as const) {
      expect(
        codeOf(() => assertCourseMayJoin({ path: path("DRAFT"), course: courseFacts({ status }) }))
      ).toBe("OK");
    }
  });

  it("a DRAFT path takes a published course that has no published lesson yet", () => {
    const course = courseFacts({ hasPublishedLesson: false });

    expect(codeOf(() => assertCourseMayJoin({ path: path("DRAFT"), course }))).toBe("OK");
  });

  it("a PUBLISHED path takes only a published course with a published lesson", () => {
    expect(
      codeOf(() => assertCourseMayJoin({ path: path("PUBLISHED"), course: courseFacts() }))
    ).toBe("OK");
  });

  it.each([
    ["a draft course", { status: "DRAFT" as const }, "NOT_PUBLISHED"],
    ["a course with no published lesson", { hasPublishedLesson: false }, "NO_PUBLISHED_LESSON"],
  ])("a PUBLISHED path refuses %s as PATH_NOT_PUBLISHABLE, naming why", (_n, over, reason) => {
    const course = courseFacts(over);

    const err = fail(() => assertCourseMayJoin({ path: path("PUBLISHED"), course }));

    expect(err).toBeInstanceOf(PathNotPublishableError);
    expect(err?.code).toBe("PATH_NOT_PUBLISHABLE");
    expect((err as PathNotPublishableError).problems).toEqual([
      { kind: "COURSE", courseId: course.id, title: course.title, reason },
    ]);
  });
});

describe("assertCourseMayLeave", () => {
  it("a DRAFT path lets any course go, the last one included", () => {
    const only = courseFacts();

    expect(
      codeOf(() => assertCourseMayLeave({ path: path2("DRAFT", [only]), courseId: only.id }))
    ).toBe("OK");
  });

  it("removing a course that is not a member is COURSE_NOT_FOUND", () => {
    const members = manyCourses(2);

    expect(
      codeOf(() => assertCourseMayLeave({ path: path2("DRAFT", members), courseId: "nope" }))
    ).toBe("COURSE_NOT_FOUND");
  });

  it("an ARCHIVED path lets nothing go", () => {
    const members = manyCourses(2);

    expect(
      codeOf(() =>
        assertCourseMayLeave({ path: path2("ARCHIVED", members), courseId: members[0].id })
      )
    ).toBe("PATH_ARCHIVED");
  });

  it("removing the last course of a PUBLISHED path is LAST_COURSE", () => {
    const only = courseFacts();

    expect(
      codeOf(() => assertCourseMayLeave({ path: path2("PUBLISHED", [only]), courseId: only.id }))
    ).toBe("LAST_COURSE");
  });

  it("removing a course from a healthy PUBLISHED path is allowed", () => {
    const members = manyCourses(3);

    expect(
      codeOf(() =>
        assertCourseMayLeave({ path: path2("PUBLISHED", members), courseId: members[1].id })
      )
    ).toBe("OK");
  });

  it("removing a healthy course that would leave only a broken one is PATH_NOT_PUBLISHABLE", () => {
    const healthy = courseFacts();
    const broken = courseFacts({ status: "ARCHIVED" });

    const err = fail(() =>
      assertCourseMayLeave({ path: path2("PUBLISHED", [healthy, broken]), courseId: healthy.id })
    );

    expect(err?.code).toBe("PATH_NOT_PUBLISHABLE");
    expect((err as PathNotPublishableError).problems).toEqual([
      { kind: "COURSE", courseId: broken.id, title: broken.title, reason: "ARCHIVED" },
    ]);
  });

  it("removing the broken course itself is always allowed: it can only improve the path", () => {
    const healthy = courseFacts();
    const broken = courseFacts({ status: "DRAFT" });
    const alsoBroken = courseFacts({ hasPublishedLesson: false });

    expect(
      codeOf(() =>
        assertCourseMayLeave({
          path: path2("PUBLISHED", [healthy, broken, alsoBroken]),
          courseId: broken.id,
        })
      )
    ).toBe("OK");
  });

  it("removing the only broken course from a path that has a healthy one is allowed", () => {
    const healthy = courseFacts();
    const broken = courseFacts({ status: "ARCHIVED" });

    expect(
      codeOf(() =>
        assertCourseMayLeave({ path: path2("PUBLISHED", [healthy, broken]), courseId: broken.id })
      )
    ).toBe("OK");
  });

  it("a member from another tenant counts as broken, so it never props a path up", () => {
    const healthy = courseFacts();
    const foreign = courseFacts({ tenantId: "tenant-b" });

    expect(
      codeOf(() =>
        assertCourseMayLeave({ path: path2("PUBLISHED", [healthy, foreign]), courseId: healthy.id })
      )
    ).toBe("PATH_NOT_PUBLISHABLE");
  });
});

function path2(status: LearningPathStatus, members: ReturnType<typeof manyCourses>) {
  return { tenantId: TENANT, status, members };
}
