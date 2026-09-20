import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { type AssignmentItem, parseAssignmentItem } from "@/lib/learner-assignment-view";
import { CourseAssignmentContext } from "./CourseAssignmentContext";

function item(over: Record<string, unknown> = {}): AssignmentItem {
  const parsed = parseAssignmentItem({
    id: "asg_1",
    courseTitle: "Client Onboarding",
    courseSlug: "client-onboarding",
    source: "MANUAL",
    status: "ASSIGNED",
    reason: { assignedByName: "Alex Rivera", note: "Before the client session." },
    dueDate: "2027-03-01T23:59:59.999Z",
    ...over,
  });
  if (!parsed) throw new Error("fixture did not parse");
  return parsed;
}

const render = (assignment: AssignmentItem, progressPercent?: number) =>
  renderToStaticMarkup(createElement(CourseAssignmentContext, { assignment, progressPercent }));

describe("CourseAssignmentContext", () => {
  it("shows that the course is assigned, why, when it is due and where it stands", () => {
    const html = render(item({ status: "STARTED" }));

    expect(html).toContain("Assigned learning");
    expect(html).toContain(">In progress<");
    expect(html).toContain("Assigned by Alex Rivera");
    expect(html).toContain("Before the client session.");
    expect(html).toContain('<time dateTime="2027-03-01T23:59:59.999Z">Mar 1, 2027</time>');
  });

  it("is a labelled section with a heading", () => {
    const html = render(item());

    expect(html).toContain('<section aria-labelledby="course-assignment-context-heading"');
    expect(html).toContain('<h2 id="course-assignment-context-heading"');
  });

  it("carries no action: no links, no buttons, no form controls", () => {
    const html = render(item({ status: "OVERDUE" }));

    expect(html).not.toMatch(/<(a|button|input|select|textarea|form)[\s>]/);
    expect(html).not.toMatch(/cancel|reassign|reactivate|edit|assign to/i);
  });

  it("omits the due date when there is none", () => {
    expect(render(item({ dueDate: null }))).not.toContain("Due ");
  });

  it("falls back to a neutral reason for a malformed snapshot", () => {
    const html = render(item({ reason: 42 }));

    expect(html).toContain("Assigned to you");
    expect(html).not.toContain("null");
  });

  it("explains a STARTED assignment sitting at 0% (L-5) and only then", () => {
    const explained = "Progress counts only lessons that are currently published.";

    expect(render(item({ status: "STARTED" }), 0)).toContain(explained);
    expect(render(item({ status: "STARTED" }), 25)).not.toContain(explained);
    expect(render(item({ status: "STARTED" }), undefined)).not.toContain(explained);
    expect(render(item({ status: "ASSIGNED" }), 0)).not.toContain(explained);
    expect(render(item({ status: "COMPLETED" }), 0)).not.toContain(explained);
  });

  it("never exposes identifiers", () => {
    expect(render(item({ id: "asg_SECRET" }))).not.toContain("asg_SECRET");
  });
});
