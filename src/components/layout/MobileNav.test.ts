import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DESKTOP_MEDIA_QUERY, MobileNav } from "./MobileNav";
import { getActiveHref, ROLE_NAV_ITEMS } from "./navItems";

const render = (props: { role: "STUDENT" | "INSTRUCTOR"; defaultOpen?: boolean }) =>
  renderToStaticMarkup(createElement(MobileNav, props));

describe("navItems — the one list both navigations read", () => {
  it("gives a learner the Dashboard, where Assigned learning lives", () => {
    expect(ROLE_NAV_ITEMS.STUDENT.map((i) => i.href)).toContain("/dashboard");
  });

  it("keeps the homework 'Assignments' item distinct from Assigned learning", () => {
    const labels = ROLE_NAV_ITEMS.STUDENT.map((i) => i.label);

    expect(labels).toContain("Assignments");
    expect(labels).not.toContain("Assigned learning");
  });

  it("marks only the most specific matching item active", () => {
    const items = ROLE_NAV_ITEMS.ORG_ADMIN;

    expect(getActiveHref(items, "/org/settings/billing")).toBe("/org/settings/billing");
    expect(getActiveHref(items, "/org/settings")).toBe("/org/settings");
    expect(getActiveHref(items, "/org/settings/branding")).toBe("/org/settings");
  });

  it("matches on path segments, not string prefixes", () => {
    expect(getActiveHref(ROLE_NAV_ITEMS.STUDENT, "/courses-archive")).toBeUndefined();
    expect(getActiveHref(ROLE_NAV_ITEMS.STUDENT, "/courses/intro/lessons/one")).toBe("/courses");
  });

  it("tolerates a missing pathname", () => {
    expect(getActiveHref(ROLE_NAV_ITEMS.STUDENT, null)).toBeUndefined();
  });
});

describe("MobileNav — closed", () => {
  it("renders a named menu button that is shown only below the md breakpoint", () => {
    const html = render({ role: "STUDENT" });

    expect(html).toMatch(/<button[^>]*aria-label="Open navigation menu"/);
    expect(html).toContain("md:hidden");
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('type="button"');
  });

  it("has a 44px tap target and a visible focus style", () => {
    const html = render({ role: "STUDENT" });

    expect(html).toContain("h-11");
    expect(html).toContain("w-11");
    expect(html).toContain("focus-visible:outline-brand");
  });

  it("does not render the navigation until it is opened", () => {
    expect(render({ role: "STUDENT" })).not.toContain("href=");
  });
});

describe("MobileNav — open: the same destinations as the desktop sidebar", () => {
  it("links every item the student sidebar has, including the Dashboard", () => {
    const html = render({ role: "STUDENT", defaultOpen: true });

    for (const item of ROLE_NAV_ITEMS.STUDENT) {
      expect(html, item.href).toContain(`href="${item.href}"`);
      expect(html, item.label).toContain(`>${item.label}<`);
    }
    expect(html).toContain('href="/dashboard"');
  });

  it("is a labelled dialog with a title and a close control", () => {
    const html = render({ role: "STUDENT", defaultOpen: true });

    expect(html).toContain('role="dialog"');
    expect(html).toContain("Menu");
    expect(html).toContain("Close navigation menu");
    expect(html).toContain('aria-label="Main"');
  });

  it("renders semantic links with mobile-sized tap targets", () => {
    const html = render({ role: "STUDENT", defaultOpen: true });

    expect(html.match(/<a /g)).toHaveLength(ROLE_NAV_ITEMS.STUDENT.length);
    expect(html).toContain("min-h-11");
    expect(html).not.toMatch(/<div[^>]*(onclick|role="button")/i);
  });

  it("is hidden again at md and up, so it can never sit alongside the sidebar", () => {
    const html = render({ role: "STUDENT", defaultOpen: true });

    expect(html.match(/md:hidden/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("uses the requested role's items", () => {
    const html = render({ role: "INSTRUCTOR", defaultOpen: true });

    expect(html).toContain('href="/instructor/dashboard"');
    expect(html).not.toContain('href="/learning-path"');
  });
});

describe("MobileNav — closes when the sidebar takes over", () => {
  it("uses Tailwind's md breakpoint (48rem) as the point at which it closes", () => {
    const globals = readFileSync(path.resolve(__dirname, "../../app/globals.css"), "utf8");

    expect(DESKTOP_MEDIA_QUERY).toBe("(min-width: 48rem)");
    expect(globals).not.toMatch(/--breakpoint-md\s*:/);
    expect(render({ role: "STUDENT" })).toContain("md:hidden");
  });

  it("is controlled: it still renders open from defaultOpen and closed by default", () => {
    expect(render({ role: "STUDENT", defaultOpen: true })).toContain('role="dialog"');
    expect(render({ role: "STUDENT" })).not.toContain('role="dialog"');
  });
});

describe("responsive wiring", () => {
  const read = (rel: string) => readFileSync(path.resolve(__dirname, "../..", rel), "utf8");

  it("the desktop sidebar is still hidden below md, so the mobile menu is what fills that gap", () => {
    expect(read("components/layout/Sidebar.tsx")).toContain("hidden md:flex");
  });

  it("the sidebar and the mobile menu import the same item list", () => {
    expect(read("components/layout/Sidebar.tsx")).toContain('from "./navItems"');
    expect(read("components/layout/MobileNav.tsx")).toContain('from "./navItems"');
  });

  it("the student layout turns the mobile menu on", () => {
    expect(read("app/(student)/layout.tsx")).toContain('navRole="STUDENT"');
  });

  it("the top bar renders the mobile menu only when given a role", () => {
    const topNav = read("components/layout/TopNav.tsx");

    expect(topNav).toContain("{navRole && <MobileNav role={navRole} />}");
  });
});
