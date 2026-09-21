import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminAssignment } from "@/lib/domain/learning-assignment/adminAssignments";
import {
  filterHref,
  isPastCalendarDate,
  presentAdminAssignment,
  SOURCE_FILTERS,
  STATUS_FILTERS,
} from "./admin-assignment-view";

const base: AdminAssignment = {
  id: "asg_1",
  learner: { name: "Sam Lee", email: "sam@example.test" },
  course: { title: "SQL Basics", slug: "sql-basics" },
  source: "MANUAL",
  reason: { kind: "MANUAL", assignedByName: "Alex Rivera", note: "Before onboarding." },
  status: "ASSIGNED",
  dueDate: new Date("2027-03-01T23:59:59.999Z"),
  createdAt: new Date("2026-09-20T10:00:00.000Z"),
  cancellation: null,
  previousCancellation: null,
};

const make = (over: Partial<AdminAssignment> = {}) => presentAdminAssignment({ ...base, ...over });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("presentAdminAssignment", () => {
  it("presents learner, course, source, status, dates and provenance in words", () => {
    expect(make()).toEqual({
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
    });
  });

  it("falls back to the email when the learner has no name", () => {
    expect(make({ learner: { name: null, email: "x@y.test" } }).learnerName).toBe("x@y.test");
    expect(make({ learner: { name: "  ", email: "x@y.test" } }).learnerName).toBe("x@y.test");
  });

  it.each([
    ["ASSIGNED", "Assigned"],
    ["STARTED", "In progress"],
    ["OVERDUE", "Overdue"],
    ["COMPLETED", "Completed"],
    ["CANCELLED", "Cancelled"],
  ] as const)("labels %s as '%s'", (status, label) => {
    expect(make({ status }).statusLabel).toBe(label);
  });

  it("only an active, unfinished assignment can be cancelled", () => {
    expect(make({ status: "ASSIGNED" }).canCancel).toBe(true);
    expect(make({ status: "STARTED" }).canCancel).toBe(true);
    expect(make({ status: "OVERDUE" }).canCancel).toBe(true);
    expect(make({ status: "COMPLETED" }).canCancel).toBe(false);
    expect(make({ status: "CANCELLED" }).canCancel).toBe(false);
  });

  it("has no due line when there is no due date", () => {
    expect(make({ dueDate: null }).due).toBeNull();
  });

  it("uses the UTC calendar date, whatever the viewer's timezone", () => {
    for (const tz of ["Asia/Kolkata", "America/Los_Angeles", "Pacific/Kiritimati"]) {
      vi.stubEnv("TZ", tz);
      expect(make().due?.label, tz).toBe("Mar 1, 2027");
      expect(make().created.label, tz).toBe("Sep 20, 2026");
    }
  });

  describe("provenance", () => {
    it("manual without an assigner or note", () => {
      const view = make({ reason: { kind: "MANUAL", assignedByName: null, note: null } });

      expect(view.reason).toEqual({ headline: "Assigned manually", note: null });
    });

    it("mandatory, with and without the team", () => {
      expect(
        make({ source: "MANDATORY", reason: { kind: "MANDATORY", teamName: "Support" } }).reason
      ).toEqual({
        headline: "Mandatory training for Support",
        note: null,
      });
      expect(
        make({ source: "MANDATORY", reason: { kind: "MANDATORY", teamName: null } }).reason.headline
      ).toBe("Mandatory training");
    });

    it("capability gap: role, skill and levels", () => {
      const view = make({
        source: "CAPABILITY_GAP",
        reason: {
          kind: "CAPABILITY_GAP",
          roleName: "Data Analyst",
          skillName: "SQL",
          requiredProficiency: "ADVANCED",
          currentProficiency: "BEGINNER",
        },
      });

      expect(view.sourceLabel).toBe("Capability gap");
      expect(view.reason.headline).toBe(
        "Capability gap for Data Analyst: SQL, beginner to advanced"
      );
    });

    it("capability gap with missing pieces still reads sensibly, never 'null'", () => {
      const view = make({
        source: "CAPABILITY_GAP",
        reason: {
          kind: "CAPABILITY_GAP",
          roleName: null,
          skillName: null,
          requiredProficiency: null,
          currentProficiency: null,
        },
      });

      expect(view.reason.headline).toBe("Capability gap: a skill gap");
      expect(view.reason.headline).not.toContain("null");
    });

    it("an unknown reason is just 'Assigned'", () => {
      expect(make({ reason: { kind: "UNKNOWN" } }).reason.headline).toBe("Assigned");
    });

    it("never carries an id", () => {
      expect(JSON.stringify(make())).not.toMatch(/tenant|assignedById|userId|courseId/);
    });
  });

  describe("cancellation state and history (M-2)", () => {
    it("a cancelled assignment says when and by whom", () => {
      const view = make({
        status: "CANCELLED",
        cancellation: { at: new Date("2026-09-21T09:00:00.000Z"), byName: "Alex Rivera" },
      });

      expect(view.cancellation).toBe("Cancelled Sep 21, 2026 by Alex Rivera");
      expect(view.history).toBeNull();
    });

    it("leaves out 'by' when the canceller is unknown", () => {
      const view = make({
        status: "CANCELLED",
        cancellation: { at: new Date("2026-09-21T09:00:00.000Z"), byName: null },
      });

      expect(view.cancellation).toBe("Cancelled Sep 21, 2026");
    });

    it("a reactivated assignment shows its history, with a count when there is more than one", () => {
      const once = make({
        previousCancellation: {
          at: new Date("2026-09-21T09:00:00.000Z"),
          byName: "Alex",
          count: 1,
        },
      });
      const twice = make({
        previousCancellation: {
          at: new Date("2026-09-21T09:00:00.000Z"),
          byName: "Alex",
          count: 2,
        },
      });

      expect(once.history).toBe("Previously cancelled Sep 21, 2026 by Alex");
      expect(twice.history).toBe("Previously cancelled Sep 21, 2026 by Alex (2 times)");
      expect(once.cancellation).toBeNull();
    });
  });
});

describe("filterHref", () => {
  it("is the bare list for no filters", () => {
    expect(filterHref({})).toBe("/org/assignments");
    expect(filterHref({ source: null, status: null })).toBe("/org/assignments");
  });

  it("carries source and status as lower-case values", () => {
    expect(filterHref({ source: "MANUAL" })).toBe("/org/assignments?source=manual");
    expect(filterHref({ status: "STARTED" })).toBe("/org/assignments?status=started");
    expect(filterHref({ source: "CAPABILITY_GAP", status: "OVERDUE" })).toBe(
      "/org/assignments?source=capability_gap&status=overdue"
    );
  });

  it("adds a cursor after the filters, url-encoded, and never for an empty one", () => {
    expect(filterHref({ status: "OVERDUE", cursor: "ab+/=" })).toBe(
      "/org/assignments?status=overdue&cursor=ab%2B%2F%3D"
    );
    expect(filterHref({ cursor: null })).toBe("/org/assignments");
    expect(filterHref({ cursor: "" })).toBe("/org/assignments");
  });

  it("never carries an identity, whatever it is given", () => {
    const href = filterHref({ source: "MANUAL", tenantId: "t1", userId: "u1" } as never);

    expect(href).not.toMatch(/tenant|user/i);
  });

  it("offers every source and status, plus 'all'", () => {
    expect(SOURCE_FILTERS.map((f) => f.value)).toEqual([
      null,
      "MANUAL",
      "MANDATORY",
      "CAPABILITY_GAP",
    ]);
    expect(STATUS_FILTERS.map((f) => f.value)).toEqual([
      null,
      "ASSIGNED",
      "STARTED",
      "OVERDUE",
      "COMPLETED",
      "CANCELLED",
    ]);
  });
});

describe("isPastCalendarDate", () => {
  const now = new Date("2026-09-20T12:00:00.000Z");

  it("is true only for a date before today's UTC date", () => {
    expect(isPastCalendarDate("2026-09-19", now)).toBe(true);
    expect(isPastCalendarDate("2020-01-01", now)).toBe(true);
    expect(isPastCalendarDate("2026-09-20", now)).toBe(false);
    expect(isPastCalendarDate("2026-09-21", now)).toBe(false);
  });

  it("is false for an empty or malformed value", () => {
    expect(isPastCalendarDate("", now)).toBe(false);
    expect(isPastCalendarDate("2026-9-1", now)).toBe(false);
    expect(isPastCalendarDate("yesterday", now)).toBe(false);
  });
});
