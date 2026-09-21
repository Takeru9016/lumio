import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { LearnerPathCourse } from "@/lib/domain/learner-path/availability";
import type { LearnerPathListItem } from "@/lib/learner-path-client";
import { presentCourse, presentPathCard } from "@/lib/learner-path-view";

const search = vi.hoisted(() => ({ value: "" }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search.value),
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

const { LearnerCourseRow } = await import("./LearnerCourseRow");
const { LearnerPathCard } = await import("./LearnerPathCard");
const { LearnerPathsClient } = await import("./LearnerPathsClient");
const { LearnerPathDetailClient } = await import("./LearnerPathDetailClient");
const { PathProgress } = await import("./PathProgress");
const { LearnerPathsSkeleton, LearnerPathDetailSkeleton } = await import("./LearnerPathSkeletons");

const render = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);

const item = (over: Partial<LearnerPathListItem> = {}): LearnerPathListItem => ({
  id: "p1",
  title: "Leadership Foundations",
  description: "Build foundational leadership capability.",
  status: "PUBLISHED",
  publishedAt: null,
  courseCount: 5,
  progress: { completed: 2, available: 3, percentage: 40 },
  ...over,
});

const course = (over: Partial<LearnerPathCourse> = {}): LearnerPathCourse =>
  ({
    courseId: "c1",
    slug: "leadership-basics",
    title: "Leadership Basics",
    position: 1,
    availability: "AVAILABLE",
    prerequisiteState: "NONE",
    ...over,
  }) as LearnerPathCourse;

describe("PathProgress", () => {
  it("draws a labelled progressbar with the server's percentage as text", () => {
    const html = render(
      createElement(PathProgress, {
        progress: presentPathCard(item()).progress,
        label: "Leadership",
      })
    );

    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-label="Progress in Leadership"');
    expect(html).toContain('aria-valuenow="40"');
    expect(html).toContain("2 of 5 courses completed");
    expect(html).toContain(">40%<");
    expect(html).toContain("width:40%");
  });

  it("draws neither a bar nor a 0% when the server had nothing to measure", () => {
    const view = presentPathCard(
      item({ progress: { completed: 0, available: 0, percentage: null } })
    ).progress;
    const html = render(createElement(PathProgress, { progress: view, label: "Leadership" }));

    expect(html).toContain("No courses are open to you yet");
    expect(html).not.toContain("progressbar");
    expect(html).not.toContain("0%");
    expect(html).not.toContain("Not started");
  });

  it("keeps a genuine 0% and turns a full path green", () => {
    const zero = render(
      createElement(PathProgress, {
        progress: presentPathCard(item({ progress: { completed: 0, available: 2, percentage: 0 } }))
          .progress,
        label: "x",
      })
    );
    expect(zero).toContain('aria-valuenow="0"');
    expect(zero).toContain(">0%<");

    const full = render(
      createElement(PathProgress, {
        progress: presentPathCard(
          item({ progress: { completed: 2, available: 0, percentage: 100 } })
        ).progress,
        label: "x",
      })
    );
    expect(full).toContain("bg-success");
  });
});

describe("LearnerPathCard", () => {
  it("is one link to the path with its title, description, count, progress and call to action", () => {
    const html = render(createElement(LearnerPathCard, { view: presentPathCard(item()) }));

    expect(html).toContain('href="/paths/p1"');
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain("<h2");
    expect(html).toContain("Leadership Foundations");
    expect(html).toContain("Build foundational leadership capability.");
    expect(html).toContain("5 courses");
    expect(html).toContain("Continue");
  });

  it("wraps long titles instead of overflowing", () => {
    const html = render(
      createElement(LearnerPathCard, {
        view: presentPathCard(item({ title: "A".repeat(200) })),
      })
    );
    expect(html).toContain("wrap-break-word");
  });

  it("omits the description block when there is none", () => {
    const html = render(
      createElement(LearnerPathCard, { view: presentPathCard(item({ description: null })) })
    );
    expect(html).not.toContain("line-clamp");
  });
});

describe("LearnerCourseRow", () => {
  const row = (c: LearnerPathCourse) =>
    render(createElement(LearnerCourseRow, { view: presentCourse(c) }));

  it("names a completed course, says so in words, and links to review it", () => {
    const html = row(course({ availability: "COMPLETED", prerequisiteState: "MET" }));

    expect(html).toContain('data-availability="COMPLETED"');
    expect(html).toContain("Completed");
    expect(html).toContain("Prerequisites complete");
    expect(html).toContain('href="/courses/leadership-basics"');
    expect(html).toContain("Review course");
    expect(html).toContain('aria-label="Review course: Leadership Basics"');
  });

  it("names an available course and links to open it", () => {
    const html = row(course());

    expect(html).toContain('data-availability="AVAILABLE"');
    expect(html).toContain("Available");
    expect(html).toContain("No prerequisites");
    expect(html).toContain("Open course");
  });

  it("draws an unavailable course with no title, no slug, no id and no link", () => {
    const html = row({
      courseId: "hidden-id",
      position: 3,
      availability: "UNAVAILABLE",
      prerequisiteState: "UNMET",
    });

    expect(html).toContain('data-availability="UNAVAILABLE"');
    expect(html).toContain("Unavailable");
    expect(html).toContain("Prerequisite required");
    expect(html).toContain("Course 3");
    expect(html).toContain(">03<");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("hidden-id");
    expect(html).not.toMatch(/leadership|Leadership Basics/);
  });

  it("gives every state its own word and icon, never colour alone", () => {
    const states = [
      row(course({ availability: "COMPLETED" })),
      row(course()),
      row({ position: 1, availability: "UNAVAILABLE", prerequisiteState: "NONE" }),
    ];
    for (const [i, word] of ["Completed", "Available", "Unavailable"].entries()) {
      expect(states[i]).toContain(word);
      expect(states[i]).toContain("<svg");
      expect(states[i]).toContain('aria-hidden="true"');
    }
  });

  it("gives an unavailable course with no prerequisite state no invented reason", () => {
    const html = row({ position: 2, availability: "UNAVAILABLE", prerequisiteState: "NONE" });
    expect(html).not.toMatch(/Prerequisite|prerequisite/);
    expect(html).not.toMatch(/because|blocked|locked by/i);
  });
});

describe("loading states", () => {
  it("shows a skeleton with a status message, never a blank page, while the list loads", () => {
    search.value = "";
    const html = render(createElement(LearnerPathsClient));

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Loading learning paths");
    expect(html).toContain("animate-pulse");
  });

  it("shows a skeleton with a status message while a path loads", () => {
    const html = render(createElement(LearnerPathDetailClient, { pathId: "p1" }));

    expect(html).toContain('role="status"');
    expect(html).toContain("Loading learning path");
    expect(html).not.toContain("<h1");
  });

  it("hides the placeholder shapes from assistive technology", () => {
    expect(render(createElement(LearnerPathsSkeleton))).toContain('aria-hidden="true"');
    expect(render(createElement(LearnerPathDetailSkeleton))).toContain('aria-hidden="true"');
  });
});
