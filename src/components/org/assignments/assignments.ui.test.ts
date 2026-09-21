import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AdminRowView } from "@/lib/admin-assignment-view";
import type { AssignmentOptions } from "@/lib/domain/learning-assignment/adminAssignments";
import {
  AssignLearningForm,
  EMPTY_ASSIGN_VALUES,
  filterLearners,
  validateAssignForm,
} from "./AssignLearningForm";
import { AssignmentFilters } from "./AssignmentFilters";
import { AssignmentList } from "./AssignmentList";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock("gooey-toast", () => ({ toast: { success: () => {}, error: () => {} } }));

const { AssignmentsClient } = await import("./AssignmentsClient");

const row = (over: Partial<AdminRowView> = {}): AdminRowView => ({
  id: "asg_1",
  learnerName: "Sam Lee",
  learnerEmail: "sam@example.test",
  courseTitle: "SQL Basics",
  source: "MANUAL",
  sourceLabel: "Manual",
  status: "ASSIGNED",
  statusLabel: "Assigned",
  due: { label: "Mar 1, 2027", iso: "2027-03-01T23:59:59.999Z" },
  created: { label: "Sep 20, 2026", iso: "2026-09-20T10:00:00.000Z" },
  reason: { headline: "Assigned by Alex Rivera", note: "Before onboarding." },
  cancellation: null,
  history: null,
  canCancel: true,
  subject: "Sam Lee, SQL Basics",
  ...over,
});

const options: AssignmentOptions = {
  learners: [
    { id: "u1", name: "Sam Lee", email: "sam@example.test" },
    { id: "u2", name: null, email: "noname@example.test" },
  ],
  courses: [
    { id: "c1", title: "SQL Basics", isCatalogue: false },
    { id: "c2", title: "Safety 101", isCatalogue: true },
  ],
};

const renderList = (rows: AdminRowView[]) =>
  renderToStaticMarkup(createElement(AssignmentList, { rows, onCancel: vi.fn() }));

describe("AssignmentList", () => {
  it("shows learner, course, source, provenance, status, due and assigned dates", () => {
    const html = renderList([row()]);

    expect(html).toContain("Sam Lee");
    expect(html).toContain("sam@example.test");
    expect(html).toContain("SQL Basics");
    expect(html).toContain(">Manual<");
    expect(html).toContain("Assigned by Alex Rivera");
    expect(html).toContain("Before onboarding.");
    expect(html).toContain('data-status="ASSIGNED"');
    expect(html).toContain('<time dateTime="2027-03-01T23:59:59.999Z">Mar 1, 2027</time>');
    expect(html).toContain('<time dateTime="2026-09-20T10:00:00.000Z">Sep 20, 2026</time>');
  });

  it("is a semantic list, one item per assignment, in the order given", () => {
    const html = renderList([
      row({ id: "1", learnerName: "Zed" }),
      row({ id: "2", learnerName: "Amy" }),
      row({ id: "3", learnerName: "Mia" }),
    ]);

    expect(html).toContain("<ul");
    expect(html.match(/<li /g)).toHaveLength(3);
    expect([...html.matchAll(/>(Zed|Amy|Mia)</g)].map((m) => m[1])).toEqual(["Zed", "Amy", "Mia"]);
  });

  it.each([
    ["ASSIGNED", "Assigned"],
    ["STARTED", "In progress"],
    ["OVERDUE", "Overdue"],
    ["COMPLETED", "Completed"],
    ["CANCELLED", "Cancelled"],
  ] as const)("renders status %s as the word '%s' with its own icon", (status, label) => {
    const html = renderList([row({ status, statusLabel: label })]);

    expect(html).toContain(`data-status="${status}"`);
    expect(html).toContain(`>${label}<`);
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
  });

  it("gives each status a different icon, so colour is never the only signal", () => {
    const icons = (["ASSIGNED", "STARTED", "OVERDUE", "COMPLETED", "CANCELLED"] as const).map(
      (s) => {
        const html = renderList([row({ status: s })]);
        return /lucide-([a-z-]+)/.exec(html.slice(html.indexOf(`data-status="${s}"`)))?.[1];
      }
    );

    expect(new Set(icons).size).toBe(5);
  });

  it("offers Cancel only for an assignment that can be cancelled", () => {
    const active = renderList([row({ canCancel: true })]);
    const done = renderList([
      row({ canCancel: false, status: "COMPLETED", statusLabel: "Completed" }),
    ]);
    const cancelled = renderList([
      row({
        canCancel: false,
        status: "CANCELLED",
        statusLabel: "Cancelled",
        cancellation: "Cancelled Sep 21, 2026 by Alex",
      }),
    ]);

    expect(active).toContain("Cancel assignment");
    expect(done).not.toContain("Cancel assignment");
    expect(cancelled).not.toContain("Cancel assignment");
  });

  it("the cancel button names its assignment, so each is distinguishable to a screen reader", () => {
    const html = renderList([
      row({ id: "1", subject: "Sam Lee, SQL Basics" }),
      row({ id: "2", subject: "Amy Wong, Safety 101" }),
    ]);

    expect(html).toContain('aria-label="Cancel assignment: Sam Lee, SQL Basics"');
    expect(html).toContain('aria-label="Cancel assignment: Amy Wong, Safety 101"');
    expect(html).toMatch(/<button[^>]*type="button"/);
  });

  it("shows cancellation state and history in words", () => {
    const cancelled = renderList([
      row({
        status: "CANCELLED",
        statusLabel: "Cancelled",
        canCancel: false,
        cancellation: "Cancelled Sep 21, 2026 by Alex Rivera",
      }),
    ]);
    const reactivated = renderList([
      row({ history: "Previously cancelled Sep 21, 2026 by Alex Rivera" }),
    ]);

    expect(cancelled).toContain("Cancelled Sep 21, 2026 by Alex Rivera");
    expect(reactivated).toContain("Previously cancelled Sep 21, 2026 by Alex Rivera");
  });

  it("omits the due line when there is none, and the email when it is the name", () => {
    const html = renderList([
      row({ due: null, learnerName: "x@y.test", learnerEmail: "x@y.test" }),
    ]);

    expect(html).not.toContain("Due ");
    expect(html.match(/x@y\.test/g)).toHaveLength(1);
  });

  it("escapes a note and names instead of injecting markup", () => {
    const html = renderList([
      row({ reason: { headline: "Assigned by <b>x</b>", note: '<img src=x onerror="alert(1)">' } }),
    ]);

    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;img");
  });

  it("has mobile-sized tap targets and a visible focus style, and no clickable divs", () => {
    const html = renderList([row()]);

    expect(html).toContain("min-h-11");
    expect(html).toContain("focus-visible:outline-brand");
    expect(html).not.toMatch(/<div[^>]*(onclick|role="button")/i);
  });

  it("stacks on a phone and splits into two columns from md up", () => {
    const html = renderList([row()]);

    expect(html).toContain("flex-col");
    expect(html).toContain("md:flex-row");
    expect(html).not.toContain("<table");
  });

  it("renders no identifier: only what the view carries", () => {
    expect(renderList([row({ id: "asg_SECRET" })])).not.toContain("asg_SECRET");
  });
});

const renderForm = (props: Partial<Parameters<typeof AssignLearningForm>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(AssignLearningForm, {
      values: EMPTY_ASSIGN_VALUES,
      onChange: vi.fn(),
      options,
      errors: {},
      submitError: null,
      notice: null,
      isSubmitting: false,
      onSubmit: vi.fn(),
      onCancel: vi.fn(),
      ...props,
    })
  );

describe("AssignLearningForm", () => {
  it("has every field labelled and associated with its control", () => {
    const html = renderForm();

    for (const id of [
      "assign-learner-search",
      "assign-learner",
      "assign-course",
      "assign-due-date",
      "assign-note",
    ]) {
      expect(html, id).toContain(`for="${id}"`);
      expect(html, id).toContain(`id="${id}"`);
    }
  });

  it("marks the due date and note as optional, and the learner and course as required choices", () => {
    const html = renderForm();

    expect(html).toMatch(/Due date[\s\S]*\(optional\)/);
    expect(html).toMatch(/Note[\s\S]*\(optional\)/);
    expect(html).toContain("Select a learner");
    expect(html).toContain("Select a course");
  });

  it("uses a native date input and a textarea capped at 500 characters with a live count", () => {
    const html = renderForm({ values: { ...EMPTY_ASSIGN_VALUES, note: "hello" } });

    expect(html).toContain('type="date"');
    expect(html).toContain("<textarea");
    expect(html).toContain('maxLength="500"');
    expect(html).toContain("5/500");
  });

  it("does not put a min on the due date: a past date is allowed (L-4 unchanged)", () => {
    expect(renderForm()).not.toMatch(/type="date"[^>]*min=/);
  });

  it("warns, without blocking, when the due date has already passed", () => {
    const html = renderForm({
      values: { ...EMPTY_ASSIGN_VALUES, dueDate: "2020-01-01" },
      now: new Date("2026-09-20T12:00:00.000Z"),
    });

    expect(html).toContain("has already passed");
    expect(html).toContain('aria-describedby="assign-due-past"');
    expect(html).not.toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
  });

  it("does not warn for today or a future date, or when blank", () => {
    const now = new Date("2026-09-20T12:00:00.000Z");
    for (const dueDate of ["", "2026-09-20", "2027-01-01"]) {
      expect(renderForm({ values: { ...EMPTY_ASSIGN_VALUES, dueDate }, now })).not.toContain(
        "already passed"
      );
    }
  });

  it("announces required-field errors and marks the controls invalid and described", () => {
    const html = renderForm({
      errors: { userId: "Choose a learner.", courseId: "Choose a course." },
    });

    expect(html).toContain('id="assign-learner-error"');
    expect(html).toContain('id="assign-course-error"');
    expect(html.match(/role="alert"/g)).toHaveLength(2);
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="assign-learner-error"');
    expect(html).toContain('aria-describedby="assign-course-error"');
  });

  it("has no error markup when there are no errors", () => {
    const html = renderForm();

    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("aria-invalid");
  });

  it("announces a server refusal as an alert", () => {
    const html = renderForm({
      submitError: "That course isn't published yet, so it can't be assigned.",
    });

    expect(html).toContain('role="alert"');
    expect(html).toContain("isn&#x27;t published yet");
  });

  it("shows the duplicate notice politely (a status), not as an error", () => {
    const html = renderForm({ notice: "This learner is already assigned this course." });

    expect(html).toContain("<output");
    expect(html).toContain("This learner is already assigned this course.");
    expect(html).not.toContain('role="alert"');
  });

  it("while submitting: the submit button is disabled and says so, and the form is busy", () => {
    const html = renderForm({ isSubmitting: true });

    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
    expect(html).toContain("Assigning…");
  });

  it("when idle: the submit button is enabled and reads 'Assign'", () => {
    const html = renderForm();

    expect(html).not.toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
    expect(html).toContain(">Assign<");
    expect(html).toContain('aria-busy="false"');
  });

  it("is a real form that submits on Enter, and has a separate Cancel button of type button", () => {
    const html = renderForm();

    expect(html).toContain("<form");
    expect(html).toContain("noValidate");
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>Cancel</);
  });

  it("uses mobile-sized controls and visible focus styles", () => {
    const html = renderForm();

    expect(html).toContain("min-h-11");
    expect(html).toContain("focus-visible:outline-brand");
  });

  it("explains when there is nobody or nothing to choose", () => {
    const html = renderForm({ options: { learners: [], courses: [] } });

    expect(html).toContain("No learners in your organisation");
    expect(html).toContain("No courses available to assign");
  });

  it("says when a search matches no learner", () => {
    const html = renderForm({
      values: { ...EMPTY_ASSIGN_VALUES, learnerQuery: "zzz" },
      options: { ...options, learners: [] },
    });

    expect(html).toContain("No learners match");
    expect(html).toContain("zzz");
  });

  it("tells the admin only published, free courses can be assigned (the server still decides)", () => {
    expect(renderForm()).toContain("Only published, free courses can be assigned.");
  });
});

describe("validateAssignForm", () => {
  it("requires a learner and a course, and nothing else", () => {
    expect(validateAssignForm(EMPTY_ASSIGN_VALUES)).toEqual({
      userId: "Choose a learner.",
      courseId: "Choose a course.",
    });
    expect(validateAssignForm({ ...EMPTY_ASSIGN_VALUES, userId: "u", courseId: "c" })).toEqual({});
    expect(validateAssignForm({ ...EMPTY_ASSIGN_VALUES, userId: "u" })).toEqual({
      courseId: "Choose a course.",
    });
  });

  it("does not judge the due date or note: the server is authoritative", () => {
    const errors = validateAssignForm({
      ...EMPTY_ASSIGN_VALUES,
      userId: "u",
      courseId: "c",
      dueDate: "1999-01-01",
      note: "x".repeat(900),
    });

    expect(errors).toEqual({});
  });
});

describe("filterLearners", () => {
  const list = [
    { id: "a", name: "Sam Lee", email: "sam@example.test" },
    { id: "b", name: "Amy Wong", email: "amy@corp.test" },
    { id: "c", name: null, email: "noname@example.test" },
  ];

  it("returns everyone for an empty or blank search", () => {
    expect(filterLearners(list, "", "")).toEqual(list);
    expect(filterLearners(list, "   ", "")).toEqual(list);
  });

  it("matches name or email, ignoring case", () => {
    expect(filterLearners(list, "SAM", "").map((l) => l.id)).toEqual(["a"]);
    expect(filterLearners(list, "corp", "").map((l) => l.id)).toEqual(["b"]);
    expect(filterLearners(list, "noname", "").map((l) => l.id)).toEqual(["c"]);
  });

  it("always keeps the selected learner, so a search never makes the selection vanish", () => {
    expect(filterLearners(list, "amy", "a").map((l) => l.id)).toEqual(["a", "b"]);
  });

  it("returns nothing for a search with no match and no selection", () => {
    expect(filterLearners(list, "zzz", "")).toEqual([]);
  });
});

describe("AssignmentFilters", () => {
  const html = (source: "MANUAL" | null, status: "OVERDUE" | null) =>
    renderToStaticMarkup(createElement(AssignmentFilters, { source, status }));

  it("renders plain links for every source and status", () => {
    const out = html(null, null);

    for (const label of [
      "All sources",
      "Manual",
      "Mandatory",
      "Capability gap",
      "All statuses",
      "Assigned",
      "In progress",
      "Overdue",
      "Completed",
      "Cancelled",
    ]) {
      expect(out, label).toContain(`>${label}<`);
    }
    expect(out.match(/<a /g)).toHaveLength(10);
    expect(out).toContain('aria-label="Filter assignments"');
  });

  it("marks the current filters, and only those", () => {
    const out = html("MANUAL", "OVERDUE");

    expect(out.match(/aria-current="true"/g)).toHaveLength(2);
    expect(out).toMatch(/aria-current="true"[^>]*>Manual</);
    expect(out).toMatch(/aria-current="true"[^>]*>Overdue</);
  });

  it("with nothing selected, 'All' is current in each group", () => {
    const out = html(null, null);

    expect(out).toMatch(/aria-current="true"[^>]*>All sources</);
    expect(out).toMatch(/aria-current="true"[^>]*>All statuses</);
  });

  it("each link keeps the other group's filter", () => {
    const out = html("MANUAL", "OVERDUE");

    expect(out).toContain('href="/org/assignments?source=manual&amp;status=overdue"');
    expect(out).toContain('href="/org/assignments?status=overdue"');
    expect(out).toContain('href="/org/assignments?source=manual"');
  });

  it("with no filter set, 'All' links to the bare list", () => {
    expect(html(null, null)).toContain('href="/org/assignments"');
  });

  it("has mobile-sized links and a visible focus style", () => {
    const out = html(null, null);

    expect(out).toContain("min-h-11");
    expect(out).toContain("focus-visible:outline-brand");
  });
});

describe("AssignmentsClient", () => {
  const render = (props: Partial<Parameters<typeof AssignmentsClient>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(AssignmentsClient, {
        rows: [],
        options,
        filtered: false,
        olderHref: null,
        newestHref: null,
        ...props,
      })
    );

  it("empty: a purposeful state with a direct call to action", () => {
    const out = render();

    expect(out).toContain("No assignments yet");
    expect(out).toContain("Assign a course to a learner");
    expect(out.match(/>Assign learning</g)).toHaveLength(2);
  });

  it("empty with filters: says so and offers a way out, not a second 'assign' prompt", () => {
    const out = render({ filtered: true });

    expect(out).toContain("No assignments match these filters");
    expect(out).toMatch(/<a [^>]*href="\/org\/assignments"[^>]*>Clear filters<\/a>/);
    expect(out).not.toContain("No assignments yet");
  });

  it("has the 'Assign learning' button at the top in every state", () => {
    expect(render()).toMatch(/<button[^>]*type="button"[^>]*>[\s\S]*Assign learning/);
    expect(render({ rows: [row()] })).toContain("Assign learning");
  });

  it("populated: renders the list", () => {
    const out = render({ rows: [row(), row({ id: "2", learnerName: "Amy Wong" })] });

    expect(out).toContain("Sam Lee");
    expect(out).toContain("Amy Wong");
    expect(out).not.toContain("No assignments yet");
  });

  it("has no paging controls when the whole list fits on one page", () => {
    const out = render({ rows: [row()] });

    expect(out).not.toContain("Assignment pages");
    expect(out).not.toContain("Older assignments");
    expect(out).not.toContain("Newest assignments");
  });

  it("says more match and links to the older page, without implying this page is everything", () => {
    const out = render({
      rows: [row()],
      filtered: true,
      olderHref: "/org/assignments?status=overdue&cursor=abc",
    });

    expect(out).toContain("Showing 1 assignments. Older ones match too");
    expect(out).toMatch(
      /<a [^>]*href="\/org\/assignments\?status=overdue&amp;cursor=abc"[^>]*>Older assignments<\/a>/
    );
    expect(out).not.toContain("Newest assignments");
    expect(out).toContain('aria-label="Assignment pages"');
  });

  it("on a later page: a way back to the newest, and on the last page it says so", () => {
    const out = render({
      rows: [row()],
      newestHref: "/org/assignments?status=overdue",
    });

    expect(out).toMatch(
      /<a [^>]*href="\/org\/assignments\?status=overdue"[^>]*>Newest assignments<\/a>/
    );
    expect(out).toContain("Showing the last 1 assignments of this list.");
    expect(out).not.toContain("Older assignments");
  });

  it("paging links are mobile-sized and keyboard-visible", () => {
    const out = render({ rows: [row()], olderHref: "/org/assignments?cursor=abc" });

    expect(out).toContain("min-h-11");
    expect(out).toContain("focus-visible:outline-brand");
  });

  it("an empty page beyond the end is not mistaken for 'no assignments' or 'no match'", () => {
    const out = render({ rows: [], filtered: true, newestHref: "/org/assignments" });

    expect(out).toContain("No more assignments");
    expect(out).toMatch(/<a [^>]*href="\/org\/assignments"[^>]*>Back to the newest<\/a>/);
    expect(out).not.toContain("No assignments match these filters");
    expect(out).not.toContain("No assignments yet");
  });

  it("renders no dialog until one is opened", () => {
    const out = render({ rows: [row()] });

    expect(out).not.toContain('role="dialog"');
    expect(out).not.toContain('role="alertdialog"');
  });

  it("the assign button is full width on a phone", () => {
    expect(render()).toContain("w-full");
  });
});

describe("security surface of the admin UI", () => {
  const root = path.resolve(__dirname, "../../..");
  const files = [
    "components/org/assignments/AssignLearningDialog.tsx",
    "components/org/assignments/AssignLearningForm.tsx",
    "components/org/assignments/AssignmentsClient.tsx",
    "components/org/assignments/CancelAssignmentDialog.tsx",
    "components/org/assignments/AssignmentFilters.tsx",
    "components/org/assignments/AssignmentList.tsx",
    "lib/admin-assignment-client.ts",
  ];
  const source = files.map((f) => readFileSync(path.join(root, f), "utf8")).join("\n");

  it("never names a tenant, an actor, a source or a key in anything it sends", () => {
    expect(source).not.toMatch(/tenantId|assignedById|sourceKey|cancelledById/);
    expect(source).not.toMatch(/source:\s*["']/);
  });

  it("only ever POSTs (assign, cancel); the list is read on the server", () => {
    expect(source).not.toMatch(/method:\s*["'](GET|PUT|PATCH|DELETE)["']/i);
    expect(source).not.toMatch(/fetch\(["'`]\/api\/org\/assignments\?/);
  });

  it("offers no reactivation, edit or delete control in this phase", () => {
    const list = renderToStaticMarkup(
      createElement(AssignmentList, {
        rows: [row({ status: "CANCELLED", statusLabel: "Cancelled", canCancel: false })],
        onCancel: vi.fn(),
      })
    );

    expect(list).not.toMatch(/reactivate|delete|edit due|reassign/i);
  });
});
