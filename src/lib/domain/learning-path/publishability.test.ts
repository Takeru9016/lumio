import { describe, expect, it } from "vitest";
import { courseFacts, manyCourses, TENANT } from "@/lib/domain/learning-path/__test__/facts";
import { assertPublishable, assessPublishability } from "@/lib/domain/learning-path/publishability";
import { LearningPathError, PathNotPublishableError } from "@/lib/domain/learning-path/types";

const input = (courses = [courseFacts()], title = "A path") => ({
  title,
  tenantId: TENANT,
  courses,
});

describe("assessPublishability", () => {
  it("one published, completable course and a valid title is publishable", () => {
    expect(assessPublishability(input())).toEqual({ publishable: true, problems: [] });
  });

  it("zero courses is not publishable", () => {
    expect(assessPublishability(input([]))).toEqual({
      publishable: false,
      problems: [{ kind: "NO_COURSES" }],
    });
  });

  it("a draft course blocks, and says so", () => {
    const draft = courseFacts({ status: "DRAFT" });

    expect(assessPublishability(input([draft])).problems).toEqual([
      { kind: "COURSE", courseId: draft.id, title: draft.title, reason: "NOT_PUBLISHED" },
    ]);
  });

  it("an archived course blocks, and says so", () => {
    const archived = courseFacts({ status: "ARCHIVED" });

    expect(assessPublishability(input([archived])).problems).toEqual([
      { kind: "COURSE", courseId: archived.id, title: archived.title, reason: "ARCHIVED" },
    ]);
  });

  it("a published course with no published, non-archived lesson blocks", () => {
    const empty = courseFacts({ hasPublishedLesson: false });

    expect(assessPublishability(input([empty])).problems).toEqual([
      { kind: "COURSE", courseId: empty.id, title: empty.title, reason: "NO_PUBLISHED_LESSON" },
    ]);
  });

  it("a tenantless course blocks as WRONG_TENANT", () => {
    const c = courseFacts({ tenantId: null });

    expect(assessPublishability(input([c])).problems).toEqual([
      { kind: "COURSE", courseId: c.id, title: c.title, reason: "WRONG_TENANT" },
    ]);
  });

  it("another tenant's course blocks as WRONG_TENANT even when it is otherwise perfect", () => {
    const c = courseFacts({ tenantId: "tenant-b" });

    expect(assessPublishability(input([c])).problems[0]).toMatchObject({ reason: "WRONG_TENANT" });
  });

  it("the tenant is checked first: a foreign archived course is WRONG_TENANT, not ARCHIVED", () => {
    const c = courseFacts({ tenantId: "tenant-b", status: "ARCHIVED" });

    expect(assessPublishability(input([c])).problems[0]).toMatchObject({ reason: "WRONG_TENANT" });
  });

  it("a mix reports exactly the blocking courses, in path order, and none of the good ones", () => {
    const [good1, good2] = manyCourses(2);
    const draft = courseFacts({ status: "DRAFT" });
    const archived = courseFacts({ status: "ARCHIVED" });
    const empty = courseFacts({ hasPublishedLesson: false });

    const result = assessPublishability(input([good1, draft, good2, archived, empty]));

    expect(result.publishable).toBe(false);
    expect(result.problems.map((p) => (p.kind === "COURSE" ? p.courseId : p.kind))).toEqual([
      draft.id,
      archived.id,
      empty.id,
    ]);
  });

  it("a valid list of many published courses is publishable", () => {
    expect(assessPublishability(input(manyCourses(20))).publishable).toBe(true);
  });

  it.each(["", "   ", "x".repeat(101)])("an invalid title (%j) blocks", (title) => {
    expect(assessPublishability(input([courseFacts()], title)).problems).toEqual([
      { kind: "INVALID_TITLE" },
    ]);
  });

  it("title, count and course problems are all reported together", () => {
    const result = assessPublishability(input([], ""));

    expect(result.problems).toEqual([{ kind: "INVALID_TITLE" }, { kind: "NO_COURSES" }]);
  });

  it("completed learners, prerequisites and progress play no part", () => {
    expect(Object.keys(courseFacts()).sort()).toEqual([
      "hasPublishedLesson",
      "id",
      "status",
      "tenantId",
      "title",
    ]);
  });
});

describe("assertPublishable", () => {
  it("returns quietly when publishable", () => {
    expect(() => assertPublishable(input())).not.toThrow();
  });

  it("throws PATH_NOT_PUBLISHABLE carrying the blockers, for an administrator", () => {
    const draft = courseFacts({ status: "DRAFT" });

    let caught: unknown;
    try {
      assertPublishable(input([draft]));
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PathNotPublishableError);
    expect(caught).toBeInstanceOf(LearningPathError);
    expect((caught as PathNotPublishableError).code).toBe("PATH_NOT_PUBLISHABLE");
    expect((caught as PathNotPublishableError).problems).toEqual([
      { kind: "COURSE", courseId: draft.id, title: draft.title, reason: "NOT_PUBLISHED" },
    ]);
  });

  it("the message is prose only: it names no course, id or tenant", () => {
    const draft = courseFacts({ status: "DRAFT", title: "Secret Draft Title" });

    try {
      assertPublishable(input([draft]));
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain(draft.id);
      expect(message).not.toContain("Secret Draft Title");
      expect(message).not.toContain(TENANT);
    }
  });
});
