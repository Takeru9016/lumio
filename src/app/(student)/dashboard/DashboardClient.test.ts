import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AssignedLearningState } from "@/components/learning-assignment/useAssignedLearning";

const hook = vi.hoisted(() => ({
  state: { kind: "loading" } as AssignedLearningState,
  retry: () => {},
}));

vi.mock("@/components/learning-assignment/useAssignedLearning", () => ({
  useAssignedLearning: () => ({ state: hook.state, retry: hook.retry }),
}));

const { DashboardClient } = await import("./DashboardClient");

const props = {
  firstName: "Sam",
  timeOfDay: "morning" as const,
  currentStreak: 0,
  enrolledCount: 2,
  avgCompletion: 40,
  xpThisWeek: 120,
  continueLearning: [
    {
      courseSlug: "client-onboarding",
      title: "Client Onboarding",
      thumbnailUrl: null,
      progress: 40,
    },
    { courseSlug: "sql-basics", title: "SQL Basics", thumbnailUrl: null, progress: 10 },
  ],
  completedCourses: [
    { courseSlug: "safety-101", title: "Safety 101", thumbnailUrl: null, progress: 100 },
  ],
  recommendations: [],
};

const render = () => renderToStaticMarkup(createElement(DashboardClient, props));

beforeEach(() => {
  hook.state = { kind: "loading" };
});

describe("DashboardClient — Assigned learning placement", () => {
  it("shows Assigned learning above the stats and the general course lists", () => {
    const html = render();

    const assigned = html.indexOf("Assigned learning");
    expect(assigned).toBeGreaterThan(-1);
    expect(assigned).toBeLessThan(html.indexOf("Enrolled courses"));
    expect(assigned).toBeLessThan(html.indexOf("Continue learning"));
  });

  it("starts in the loading state, with the rest of the dashboard already rendered", () => {
    const html = render();

    expect(html).toContain("Loading your assigned learning");
    expect(html).toContain("Good morning, Sam");
    expect(html).toContain("Client Onboarding");
  });
});

describe("DashboardClient — a failed assignments request does not take the dashboard down", () => {
  it("shows the section's own error state and every unrelated section alongside it", () => {
    hook.state = { kind: "error" };

    const html = render();

    expect(html).toContain('role="alert"');
    expect(html).toContain("We couldn&#x27;t load your assigned learning");

    expect(html).toContain("Good morning, Sam");
    expect(html).toContain("Enrolled courses");
    expect(html).toContain("XP this week");
    expect(html).toContain("Continue learning");
    expect(html).toContain("Client Onboarding");
    expect(html).toContain("SQL Basics");
    expect(html).toContain("Completed (1)");
    expect(html).toContain("AI Learning Path");
    expect(html).toContain('href="/courses/sql-basics"');
  });

  it("the dashboard itself shows no raw error text", () => {
    hook.state = { kind: "error" };

    expect(render()).not.toMatch(/prisma|LearningAssignment|TypeError|Failed to fetch/i);
  });
});

describe("DashboardClient — with assignments", () => {
  it("renders the assignment cards above Continue learning and links by slug", () => {
    hook.state = {
      kind: "ready",
      assignments: [
        {
          id: "a1",
          courseSlug: "client-onboarding",
          courseTitle: "Client Onboarding",
          source: "MANUAL",
          reason: { kind: "MANUAL", assignedByName: "Alex", note: null },
          dueDate: "2027-03-01T23:59:59.999Z",
          status: "STARTED",
        },
      ],
    };

    const html = render();

    expect(html).toContain("Assigned by Alex");
    expect(html).toContain("Due <time");
    expect(html.indexOf("Assigned by Alex")).toBeLessThan(html.indexOf("Continue learning"));
    expect(html).toContain('href="/courses/client-onboarding"');
  });

  it("uses the same percentage as the Continue learning card for the same course", () => {
    hook.state = {
      kind: "ready",
      assignments: [
        {
          id: "a1",
          courseSlug: "client-onboarding",
          courseTitle: "Client Onboarding",
          source: "MANUAL",
          reason: { kind: "MANUAL", assignedByName: null, note: null },
          dueDate: null,
          status: "STARTED",
        },
      ],
    };

    const html = render();

    expect(html.match(/40% complete/g)).toHaveLength(1);
    expect(html).toContain('aria-valuenow="40"');
    expect(html).toContain(">40%<");
  });

  it("shows the purposeful empty state when nothing is assigned", () => {
    hook.state = { kind: "ready", assignments: [] };

    const html = render();

    expect(html).toContain("No assigned learning yet");
    expect(html).toContain("Continue learning");
  });
});
