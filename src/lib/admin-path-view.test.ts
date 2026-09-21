import { describe, expect, it } from "vitest";

import type { AdminFailure, AdminPathCourse, AdminPathSummary } from "@/lib/admin-path-client";
import {
  adminListQuery,
  describeProblems,
  filterHref,
  moveCourse,
  orgPathHref,
  parseStatusFilter,
  pathActions,
  placeFailure,
  planAfterChange,
  presentAdminCourse,
  presentPathRow,
  STATUS_FILTERS,
  sameOrder,
} from "@/lib/admin-path-view";

const summary = (over: Partial<AdminPathSummary> = {}): AdminPathSummary => ({
  id: "p1",
  title: "Leadership",
  description: null,
  status: "DRAFT",
  publishedAt: null,
  createdAt: "2026-09-20T10:00:00.000Z",
  updatedAt: "2026-09-20T10:00:00.000Z",
  courseCount: 3,
  ...over,
});

describe("status filter", () => {
  it("offers All, Draft, Published and Archived, and only those", () => {
    expect(STATUS_FILTERS.map((f) => [f.label, f.value])).toEqual([
      ["All", null],
      ["Draft", "DRAFT"],
      ["Published", "PUBLISHED"],
      ["Archived", "ARCHIVED"],
    ]);
  });

  it("lets only a real status through from the URL", () => {
    expect(parseStatusFilter("PUBLISHED")).toBe("PUBLISHED");
    expect(parseStatusFilter("published")).toBeNull();
    expect(parseStatusFilter("DELETED")).toBeNull();
    expect(parseStatusFilter("")).toBeNull();
    expect(parseStatusFilter(null)).toBeNull();
  });

  it("builds a link that keeps the filter and the cursor", () => {
    expect(filterHref({ status: null })).toBe("/org/paths");
    expect(filterHref({ status: "DRAFT" })).toBe("/org/paths?status=DRAFT");
    expect(filterHref({ status: "DRAFT", cursor: "a b" })).toBe(
      "/org/paths?status=DRAFT&cursor=a+b"
    );
    expect(filterHref({ status: null, cursor: "c" })).toBe("/org/paths?cursor=c");
  });
});

describe("presentPathRow", () => {
  it("words the status, the count and the dates", () => {
    expect(
      presentPathRow(
        summary({ status: "PUBLISHED", publishedAt: "2026-09-21T00:00:00.000Z", courseCount: 1 })
      )
    ).toMatchObject({
      href: "/org/paths/p1",
      statusLabel: "Published",
      courseCountLabel: "1 course",
      created: "Sep 20, 2026",
      published: "Sep 21, 2026",
    });
    expect(presentPathRow(summary()).published).toBeNull();
  });

  it("encodes the id in the link", () => {
    expect(orgPathHref("a/b")).toBe("/org/paths/a%2Fb");
  });
});

describe("pathActions", () => {
  it.each([
    [
      "DRAFT",
      {
        canEdit: true,
        canManageCourses: true,
        canPublish: true,
        canRepublish: false,
        canArchive: true,
      },
    ],
    [
      "PUBLISHED",
      {
        canEdit: true,
        canManageCourses: true,
        canPublish: false,
        canRepublish: false,
        canArchive: true,
      },
    ],
    [
      "ARCHIVED",
      {
        canEdit: false,
        canManageCourses: false,
        canPublish: false,
        canRepublish: true,
        canArchive: false,
      },
    ],
  ] as const)("%s offers %j", (status, expected) => {
    expect(pathActions(status)).toEqual(expected);
  });
});

describe("presentAdminCourse", () => {
  const course: AdminPathCourse = {
    courseId: "c1",
    slug: "sql",
    title: "SQL",
    position: 2,
    courseStatus: "DRAFT",
    availability: "UNAVAILABLE",
    blockReason: "NOT_PUBLISHED",
  };

  it("shows the management facts the admin API provides", () => {
    expect(presentAdminCourse(course)).toEqual({
      courseId: "c1",
      slug: "sql",
      title: "SQL",
      positionLabel: "02",
      statusLabel: "Draft",
      courseStatus: "DRAFT",
      blockNote: "This course isn't published yet",
    });
  });

  it("has no block note when nothing blocks the course", () => {
    expect(presentAdminCourse({ ...course, blockReason: null }).blockNote).toBeNull();
  });
});

describe("moveCourse and sameOrder", () => {
  it("moves one id by one place", () => {
    expect(moveCourse(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveCourse(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
  });

  it("leaves the order alone at either end or out of range", () => {
    expect(moveCourse(["a", "b"], 0, -1)).toEqual(["a", "b"]);
    expect(moveCourse(["a", "b"], 1, 1)).toEqual(["a", "b"]);
    expect(moveCourse(["a", "b"], 5, -1)).toEqual(["a", "b"]);
  });

  it("does not change its input", () => {
    const ids = ["a", "b"];
    moveCourse(ids, 0, 1);
    expect(ids).toEqual(["a", "b"]);
  });

  it("compares orders by position", () => {
    expect(sameOrder(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameOrder(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameOrder(["a"], ["a", "b"])).toBe(false);
  });
});

describe("describeProblems", () => {
  it("lists exactly the courses the server named, with what is wrong with each", () => {
    expect(
      describeProblems([
        { kind: "COURSE", courseId: "c1", title: "Leadership Basics", reason: "NOT_PUBLISHED" },
        {
          kind: "COURSE",
          courseId: "c2",
          title: "Advanced Negotiation",
          reason: "NO_PUBLISHED_LESSON",
        },
        { kind: "COURSE", courseId: "c3", title: "Old", reason: "ARCHIVED" },
      ])
    ).toEqual({
      intro: "3 courses need attention:",
      items: [
        { key: "course-c1", text: "Leadership Basics isn't published" },
        { key: "course-c2", text: "Advanced Negotiation has no published lessons" },
        { key: "course-c3", text: "Old is archived" },
      ],
    });
  });

  it("gives a course the server sent only by id no title of its own", () => {
    const view = describeProblems([{ kind: "COURSE", courseId: "x", reason: "WRONG_TENANT" }]);
    expect(view?.items).toEqual([
      { key: "course-x", text: "A course isn't part of your organisation" },
    ]);
    expect(JSON.stringify(view)).not.toMatch(/"x"|undefined/);
  });

  it("words the path-level problems without a course count", () => {
    expect(describeProblems([{ kind: "NO_COURSES" }])).toEqual({
      intro: null,
      items: [{ key: "none-0", text: "The path has no courses. Add at least one." }],
    });
    expect(describeProblems([{ kind: "INVALID_TITLE" }])?.items[0].text).toBe(
      "The path needs a title."
    );
  });

  it("does not invent a reason for an unknown one, and says nothing when nothing was sent", () => {
    expect(
      describeProblems([{ kind: "COURSE", courseId: "c", title: "T", reason: "SOMETHING_NEW" }])
        ?.items[0].text
    ).toBe("T needs attention");
    expect(describeProblems([])).toBeNull();
    expect(describeProblems([null, 5, "x", { kind: "UNKNOWN" }])).toBeNull();
  });
});

describe("adminListQuery", () => {
  it("asks the API for the URL's filter and cursor and nothing else", () => {
    expect(
      adminListQuery(new URLSearchParams("status=DRAFT&cursor=abc&limit=500&tenantId=x"))
    ).toEqual({
      status: "DRAFT",
      cursor: "abc",
    });
    expect(adminListQuery(new URLSearchParams(""))).toEqual({ status: null, cursor: null });
  });

  it("never passes an invented status on", () => {
    expect(adminListQuery(new URLSearchParams("status=DELETED")).status).toBeNull();
  });
});

const refusal = (over: Partial<AdminFailure> = {}): AdminFailure => ({
  message: "words",
  code: "DUPLICATE",
  status: 409,
  problems: [],
  refresh: true,
  ...over,
});

describe("planAfterChange", () => {
  it("toasts and re-reads the path after a change that went through", () => {
    expect(planAfterChange({ kind: "ok", data: {} }, "Course added")).toEqual({
      toast: "Course added",
      refresh: true,
      resetOrder: false,
      failure: null,
    });
  });

  it("re-reads the path, and says nothing pleasant, after a refusal that means it is out of date", () => {
    const failure = refusal();
    expect(planAfterChange({ kind: "error", failure }, "Course added")).toEqual({
      toast: null,
      refresh: true,
      resetOrder: false,
      failure,
    });
  });

  it("leaves the path alone after a refusal that says nothing about it being out of date", () => {
    const failure = refusal({ code: "INVALID_INPUT", status: 400, refresh: false });
    expect(planAfterChange({ kind: "error", failure }, "Saved")).toMatchObject({
      refresh: false,
      resetOrder: false,
      toast: null,
    });
  });

  it("throws away a local order only when the server says the courses changed underneath it", () => {
    const plan = (code: string) =>
      planAfterChange({ kind: "error", failure: refusal({ code }) }, "x").resetOrder;
    expect(plan("STALE_ORDER")).toBe(true);
    for (const code of ["DUPLICATE", "PATH_ARCHIVED", "LAST_COURSE", "PATH_NOT_PUBLISHABLE"]) {
      expect(plan(code), code).toBe(false);
    }
  });
});

describe("placeFailure", () => {
  it("keeps a refusal that moved the server at page level, where it cannot be lost", () => {
    const failure = refusal({ refresh: true });
    expect(placeFailure(failure)).toEqual({ page: failure, local: null });
  });

  it("leaves any other refusal with whoever asked", () => {
    const failure = refusal({ refresh: false, code: "INVALID_INPUT", status: 400 });
    expect(placeFailure(failure)).toEqual({ page: null, local: failure });
  });

  it("has nothing to place after success", () => {
    expect(placeFailure(null)).toEqual({ page: null, local: null });
  });
});
