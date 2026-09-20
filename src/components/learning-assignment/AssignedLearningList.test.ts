import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AssignmentItem, parseAssignmentItem } from "@/lib/learner-assignment-view";
import { AssignedLearningList } from "./AssignedLearningList";
import type { AssignedLearningState } from "./useAssignedLearning";

function item(over: Record<string, unknown> = {}): AssignmentItem {
  const parsed = parseAssignmentItem({
    id: "asg_1",
    courseTitle: "Client Onboarding",
    courseSlug: "client-onboarding",
    source: "MANUAL",
    status: "ASSIGNED",
    reason: { assignedByName: "Alex Rivera" },
    dueDate: null,
    ...over,
  });
  if (!parsed) throw new Error("fixture did not parse");
  return parsed;
}

function render(state: AssignedLearningState, progress: Record<string, number> = {}) {
  return renderToStaticMarkup(
    createElement(AssignedLearningList, {
      state,
      progressBySlug: new Map(Object.entries(progress)),
      onRetry: vi.fn(),
    })
  );
}

const ready = (...assignments: AssignmentItem[]): AssignedLearningState => ({
  kind: "ready",
  assignments,
});

describe("AssignedLearningList — rendering each status", () => {
  it.each([
    ["ASSIGNED", "Assigned", "Start course"],
    ["STARTED", "In progress", "Continue"],
    ["OVERDUE", "Overdue", "Continue"],
    ["COMPLETED", "Completed", "Review"],
  ])("%s shows the %s label and a %s action", (status, label, cta) => {
    const html = render(ready(item({ status })));

    expect(html).toContain(`data-status="${status}"`);
    expect(html).toContain(`>${label}<`);
    expect(html).toContain(cta);
  });

  it("gives every status its own icon so colour is never the only signal", () => {
    const icons = ["ASSIGNED", "STARTED", "OVERDUE", "COMPLETED"].map((status) => {
      const html = render(ready(item({ status })));
      return /lucide-([a-z-]+)/.exec(html.slice(html.indexOf(`data-status="${status}"`)))?.[1];
    });

    expect(new Set(icons).size).toBe(4);
  });

  it("hides decorative icons from assistive technology", () => {
    const html = render(ready(item({ status: "OVERDUE" })));

    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
  });

  it("renders the course title, the due date and the reason", () => {
    const html = render(
      ready(
        item({
          dueDate: "2027-03-01T23:59:59.999Z",
          reason: { assignedByName: "Alex Rivera", note: "Please finish before onboarding." },
        })
      )
    );

    expect(html).toContain("Client Onboarding");
    expect(html).toContain("Assigned by Alex Rivera");
    expect(html).toContain("Please finish before onboarding.");
    expect(html).toContain('<time dateTime="2027-03-01T23:59:59.999Z">Mar 1, 2027</time>');
  });

  it("omits the due line entirely when there is no due date", () => {
    expect(render(ready(item()))).not.toContain("Due ");
  });

  it("renders mandatory and capability-gap reasons", () => {
    const html = render(
      ready(
        item({ id: "m", courseSlug: "m", source: "MANDATORY", reason: { teamName: "Support" } }),
        item({
          id: "g",
          courseSlug: "g",
          source: "CAPABILITY_GAP",
          reason: {
            roleName: "Data Analyst",
            skillName: "SQL",
            requiredProficiency: "ADVANCED",
            currentProficiency: "BEGINNER",
          },
        })
      )
    );

    expect(html).toContain("Required for your team: Support");
    expect(html).toContain("Recommended for your role: Data Analyst");
    expect(html).toContain("SQL: beginner to advanced");
  });

  it("a null or malformed reason still renders a usable card", () => {
    for (const reason of [null, "garbage", [], { assignedByName: 42 }]) {
      const html = render(ready(item({ reason })));

      expect(html).toContain("Client Onboarding");
      expect(html).toContain("Assigned to you");
      expect(html).toContain("Start course");
      expect(html).not.toContain("null");
      expect(html).not.toContain("undefined");
    }
  });

  it("escapes a note instead of injecting it as markup", () => {
    const html = render(
      ready(item({ reason: { assignedByName: "A", note: '<img src=x onerror="alert(1)">' } }))
    );

    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("AssignedLearningList — due date is the intended calendar date, not the viewer's", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["Asia/Kolkata", "2026-09-25T23:59:59.999Z"],
    ["Asia/Kolkata", "2026-09-25T00:00:00.000Z"],
    ["America/Los_Angeles", "2026-09-25T23:59:59.999Z"],
    ["America/Los_Angeles", "2026-09-25T00:00:00.000Z"],
  ])("%s viewer, stored %s, is shown Sep 25, 2026", (zone, dueDate) => {
    vi.stubEnv("TZ", zone);

    const html = render(ready(item({ dueDate })));

    expect(html).toContain(`<time dateTime="${dueDate}">Sep 25, 2026</time>`);
    expect(html).not.toContain("Sep 26, 2026");
    expect(html).not.toContain("Sep 24, 2026");
  });
});

describe("AssignedLearningList — navigation", () => {
  it.each([
    ["ASSIGNED", "Start course"],
    ["STARTED", "Continue"],
    ["OVERDUE", "Continue"],
    ["COMPLETED", "Review"],
  ])("a %s card is one link to the canonical slug URL containing '%s'", (status, cta) => {
    const html = render(ready(item({ status, courseSlug: "client-onboarding" })));

    const links = html.match(/<a [^>]*>/g) ?? [];
    expect(links).toHaveLength(1);
    expect(links[0]).toContain('href="/courses/client-onboarding"');
    expect(html).toContain(cta);
  });

  it("never links by an id, and never nests a second interactive element in the link", () => {
    const html = render(ready(item({ id: "asg_SECRET_ID" })));

    expect(html).not.toContain("asg_SECRET_ID");
    expect(html).not.toContain("<button");
    expect(html.match(/<a /g)).toHaveLength(1);
  });

  it("does not use clickable divs", () => {
    expect(render(ready(item()))).not.toMatch(/<div[^>]*(onclick|role="button"|tabindex)/i);
  });
});

describe("AssignedLearningList — ordering", () => {
  it("renders assignments in exactly the order the API returned, with no client-side ranking", () => {
    const html = render(
      ready(
        item({ id: "1", courseSlug: "zeta", courseTitle: "Zeta", status: "COMPLETED" }),
        item({
          id: "2",
          courseSlug: "alpha",
          courseTitle: "Alpha",
          status: "OVERDUE",
          dueDate: "2020-01-01T00:00:00.000Z",
        }),
        item({
          id: "3",
          courseSlug: "mid",
          courseTitle: "Mid",
          status: "ASSIGNED",
          dueDate: "2099-01-01T00:00:00.000Z",
        })
      )
    );

    const order = [...html.matchAll(/href="\/courses\/([^"]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["zeta", "alpha", "mid"]);
  });

  it("renders several assignments as a list of cards", () => {
    const html = render(
      ready(
        item({ id: "1", courseSlug: "a" }),
        item({ id: "2", courseSlug: "b" }),
        item({ id: "3", courseSlug: "c" })
      )
    );

    expect(html.match(/<li>/g)).toHaveLength(3);
    expect(html).toContain("<ul");
  });
});

describe("AssignedLearningList — L-5 progress handling", () => {
  it("shows the dashboard's percentage for an in-progress assignment", () => {
    const html = render(ready(item({ status: "STARTED" })), { "client-onboarding": 42 });

    expect(html).toContain("42% complete");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="42"');
    expect(html).not.toContain("currently published");
  });

  it("STARTED at 0% shows the 0% and explains that only published lessons are counted", () => {
    const html = render(ready(item({ status: "STARTED" })), { "client-onboarding": 0 });

    expect(html).toContain(">In progress<");
    expect(html).toContain("0% complete");
    expect(html).toContain("Progress counts only lessons that are currently published.");
  });

  it("does not fabricate a figure when the dashboard has none for the course", () => {
    const html = render(ready(item({ status: "STARTED" })));

    expect(html).not.toContain("progressbar");
    expect(html).not.toContain("%");
  });

  it("does not show a bar for assigned or completed items, even if a number exists", () => {
    for (const status of ["ASSIGNED", "COMPLETED"]) {
      expect(render(ready(item({ status })), { "client-onboarding": 55 })).not.toContain(
        "progressbar"
      );
    }
  });

  it("a course slug that collides with an object property name yields no figure, not NaN", () => {
    const html = render(ready(item({ status: "STARTED", courseSlug: "constructor" })), {});

    expect(html).not.toContain("NaN");
    expect(html).not.toContain("progressbar");
  });
});

describe("AssignedLearningList — loading, error and empty states", () => {
  it("loading: an announced status region with shape-matched skeletons, no spinner, no cards", () => {
    const html = render({ kind: "loading" });

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Loading your assigned learning");
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("<a ");
  });

  it("error: an alert with a retry button, and no raw error text", () => {
    const html = render({ kind: "error" });

    expect(html).toContain('role="alert"');
    expect(html).toContain("We couldn&#x27;t load your assigned learning");
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>Try again<\/button>/);
    expect(html).not.toMatch(/prisma|LearningAssignment|stack|500/i);
  });

  it("empty: a purposeful message that points at the catalogue and does not imply obligation", () => {
    const html = render(ready());

    expect(html).toContain("No assigned learning yet");
    expect(html).toContain("Explore courses from the catalogue when you&#x27;re ready.");
    expect(html).toMatch(/<a [^>]*href="\/courses"[^>]*>Explore courses<\/a>/);
    expect(html).not.toMatch(/required|must|overdue/i);
    expect(html).not.toContain('role="alert"');
  });

  it("always renders one labelled section landmark with a heading", () => {
    for (const state of [
      { kind: "loading" },
      { kind: "error" },
      ready(),
    ] as AssignedLearningState[]) {
      const html = render(state);

      expect(html).toContain('<section aria-labelledby="assigned-learning-heading"');
      expect(html).toContain('<h2 id="assigned-learning-heading"');
      expect(html).toContain("Assigned learning");
    }
  });
});

describe("AssignedLearningList — accessibility affordances", () => {
  it("cards and the retry button have visible focus styles and mobile-sized tap targets", () => {
    const card = render(ready(item()));
    const retry = render({ kind: "error" });

    expect(card).toContain("focus-visible:outline-brand");
    expect(card).toContain("min-h-11");
    expect(retry).toContain("focus-visible:outline-brand");
    expect(retry).toContain("min-h-11");
  });

  it("the due date is a machine-readable time element", () => {
    expect(render(ready(item({ dueDate: "2027-03-01T23:59:59.999Z" })))).toMatch(
      /<time dateTime="2027-03-01T23:59:59.999Z">/
    );
  });
});

describe("AssignedLearning — security surface", () => {
  const files = [
    path.resolve(__dirname, "../../lib/learner-assignment-view.ts"),
    path.resolve(__dirname, "AssignedLearning.tsx"),
    path.resolve(__dirname, "AssignedLearningList.tsx"),
    path.resolve(__dirname, "AssignmentStatusBadge.tsx"),
    path.resolve(__dirname, "useAssignedLearning.ts"),
  ];
  const source = files.map((f) => readFileSync(f, "utf8")).join("\n");

  it("never builds an identity into a request: no userId or tenantId in any URL", () => {
    expect(source).not.toMatch(/[?&](userId|tenantId)=/);
    expect(source).not.toMatch(/\$\{[^}]*(userId|tenantId)[^}]*\}/);
  });

  it("only ever issues GET requests", () => {
    expect(source).not.toMatch(/method:\s*["'](POST|PUT|PATCH|DELETE)["']/i);
  });

  it("offers no administrative assignment action", () => {
    const rendered = render(ready(item({ status: "ASSIGNED" })));

    expect(rendered).not.toMatch(/cancel|reassign|reactivate|edit due|assign to/i);
  });
});
