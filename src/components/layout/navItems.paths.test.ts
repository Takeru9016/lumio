import { describe, expect, it } from "vitest";

import { getActiveHref, ROLE_NAV_ITEMS } from "./navItems";

describe("learning path navigation", () => {
  it("gives a learner Learning Paths without touching the AI Learning Path item", () => {
    const items = ROLE_NAV_ITEMS.STUDENT;

    expect(items.find((i) => i.href === "/learning-path")?.label).toBe("Learning Path");
    expect(items.find((i) => i.href === "/paths")?.label).toBe("Learning Paths");
    expect(new Set(items.map((i) => i.href)).size).toBe(items.length);
    expect(new Set(items.map((i) => i.label)).size).toBe(items.length);
  });

  it("gives an organisation admin Learning Paths, and only them", () => {
    expect(ROLE_NAV_ITEMS.ORG_ADMIN.find((i) => i.href === "/org/paths")?.label).toBe(
      "Learning Paths"
    );
    for (const role of ["INSTRUCTOR", "SUPER_ADMIN"] as const) {
      expect(ROLE_NAV_ITEMS[role].some((i) => i.href.includes("paths"))).toBe(false);
    }
  });

  it("keeps the two learner surfaces from lighting each other up", () => {
    const items = ROLE_NAV_ITEMS.STUDENT;

    expect(getActiveHref(items, "/paths")).toBe("/paths");
    expect(getActiveHref(items, "/paths/abc")).toBe("/paths");
    expect(getActiveHref(items, "/learning-path")).toBe("/learning-path");
    expect(getActiveHref(items, "/learning-paths-old")).toBeUndefined();
  });

  it("marks the admin editor as part of Learning Paths, not of Courses", () => {
    const items = ROLE_NAV_ITEMS.ORG_ADMIN;

    expect(getActiveHref(items, "/org/paths")).toBe("/org/paths");
    expect(getActiveHref(items, "/org/paths/abc")).toBe("/org/paths");
    expect(getActiveHref(items, "/org/courses")).toBe("/org/courses");
  });
});
