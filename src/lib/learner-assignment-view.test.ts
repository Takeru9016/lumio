import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ASSIGNMENTS_ENDPOINT,
  type AssignmentItem,
  formatDueDate,
  loadAssignedLearning,
  parseAssignmentItem,
  parseAssignmentsResponse,
  presentAssignment,
  presentProgress,
} from "./learner-assignment-view";

const base = {
  id: "asg_1",
  courseId: "course_1",
  courseTitle: "Client Onboarding",
  courseSlug: "client-onboarding",
  dueDate: null,
  createdAt: "2026-09-01T00:00:00.000Z",
};

const manual = (extra = {}) => ({
  ...base,
  source: "MANUAL",
  status: "ASSIGNED",
  reason: { assignedByName: "Alex Rivera" },
  ...extra,
});

function item(raw: unknown): AssignmentItem {
  const parsed = parseAssignmentItem(raw);
  if (!parsed) throw new Error("fixture did not parse");
  return parsed;
}

const jsonResponse = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

describe("parseAssignmentItem", () => {
  it("keeps only what the card needs and drops administrative fields", () => {
    const parsed = item(
      manual({ assignedById: "u_admin", tenantId: "t_1", userId: "u_1", sourceKey: "manual:c" })
    );

    expect(Object.keys(parsed).sort()).toEqual(
      ["courseSlug", "courseTitle", "dueDate", "id", "reason", "source", "status"].sort()
    );
  });

  it.each([
    ["missing id", { id: undefined }],
    ["empty slug", { courseSlug: "" }],
    ["non-string title", { courseTitle: 5 }],
    ["unknown status", { status: "CANCELLED" }],
    ["absent status", { status: undefined }],
  ])("rejects an item with %s", (_label, override) => {
    expect(parseAssignmentItem(manual(override))).toBeNull();
  });

  it.each([null, undefined, "x", 5, [], true])("rejects a non-object item (%s)", (raw) => {
    expect(parseAssignmentItem(raw)).toBeNull();
  });

  it("treats an unparseable due date as no due date rather than failing the card", () => {
    expect(item(manual({ dueDate: "not a date" })).dueDate).toBeNull();
    expect(item(manual({ dueDate: 12345 })).dueDate).toBeNull();
    expect(item(manual({ dueDate: "2027-03-01T23:59:59.999Z" })).dueDate).toBe(
      "2027-03-01T23:59:59.999Z"
    );
  });
});

describe("parseAssignmentsResponse", () => {
  it("returns the items in the order the API sent them", () => {
    const body = {
      assignments: [
        manual({ id: "b", courseSlug: "b" }),
        manual({ id: "a", courseSlug: "a" }),
        manual({ id: "c", courseSlug: "c" }),
      ],
    };

    expect(parseAssignmentsResponse(body)?.map((i) => i.id)).toEqual(["b", "a", "c"]);
  });

  it("drops items that cannot be rendered but keeps the rest", () => {
    const body = { assignments: [manual({ id: "ok" }), { nonsense: true }, manual({ id: "ok2" })] };

    expect(parseAssignmentsResponse(body)?.map((i) => i.id)).toEqual(["ok", "ok2"]);
  });

  it.each([null, undefined, {}, { assignments: "x" }, { assignments: null }, [], "x"])(
    "returns null for a malformed envelope (%j)",
    (body) => {
      expect(parseAssignmentsResponse(body)).toBeNull();
    }
  );

  it("accepts an empty list", () => {
    expect(parseAssignmentsResponse({ assignments: [] })).toEqual([]);
  });
});

describe("presentAssignment — status, CTA and canonical course URL", () => {
  it.each([
    ["ASSIGNED", "Assigned", "Start course"],
    ["STARTED", "In progress", "Continue"],
    ["OVERDUE", "Overdue", "Continue"],
    ["COMPLETED", "Completed", "Review"],
  ])("%s shows %s with the %s action", (status, statusLabel, ctaLabel) => {
    const view = presentAssignment(item(manual({ status })));

    expect(view.statusLabel).toBe(statusLabel);
    expect(view.ctaLabel).toBe(ctaLabel);
  });

  it("links to the course by slug, never by id", () => {
    const view = presentAssignment(item(manual()));

    expect(view.href).toBe("/courses/client-onboarding");
    expect(view.href).not.toContain("course_1");
    expect(view.href).not.toContain("asg_1");
  });

  it("encodes a slug so it can never change the path", () => {
    const view = presentAssignment(item(manual({ courseSlug: "a/b?x=1" })));

    expect(view.href).toBe("/courses/a%2Fb%3Fx%3D1");
  });
});

describe("presentAssignment — reason", () => {
  it("manual: names the assigner and carries the note", () => {
    const view = presentAssignment(
      item(
        manual({ reason: { assignedByName: "Alex Rivera", note: "Before the client session." } })
      )
    );

    expect(view.reason).toEqual({
      headline: "Assigned by Alex Rivera",
      detail: null,
      note: "Before the client session.",
    });
  });

  it("manual: falls back to a neutral line when the assigner is unknown (never 'Assigned by null')", () => {
    for (const reason of [{ assignedByName: null }, { assignedByName: "" }, {}]) {
      const view = presentAssignment(item(manual({ reason })));
      expect(view.reason.headline, JSON.stringify(reason)).toBe("Assigned to you");
      expect(view.reason.headline).not.toContain("null");
      expect(view.reason.note).toBeNull();
    }
  });

  it("mandatory: required for the team, naming it when known", () => {
    const named = presentAssignment(
      item({ ...base, source: "MANDATORY", status: "ASSIGNED", reason: { teamName: "Support" } })
    );
    const unnamed = presentAssignment(
      item({ ...base, source: "MANDATORY", status: "ASSIGNED", reason: null })
    );

    expect(named.reason.headline).toBe("Required for your team: Support");
    expect(unnamed.reason.headline).toBe("Required for your team");
  });

  it("capability gap: recommended for the role, with the skill and levels", () => {
    const view = presentAssignment(
      item({
        ...base,
        source: "CAPABILITY_GAP",
        status: "ASSIGNED",
        reason: {
          roleName: "Data Analyst",
          skillName: "SQL",
          requiredProficiency: "ADVANCED",
          currentProficiency: "BEGINNER",
        },
      })
    );

    expect(view.reason.headline).toBe("Recommended for your role: Data Analyst");
    expect(view.reason.detail).toBe("SQL: beginner to advanced");
  });

  it.each([
    ["null", null],
    ["a string", "oops"],
    ["an array", []],
    ["wrong field types", { roleName: 1, skillName: {}, requiredProficiency: 3 }],
    [
      "an unknown proficiency",
      { roleName: "R", skillName: "S", requiredProficiency: "GOD", currentProficiency: "NONE" },
    ],
  ])("capability gap with a %s reason still renders a neutral card", (_label, reason) => {
    const view = presentAssignment(
      item({ ...base, source: "CAPABILITY_GAP", status: "STARTED", reason })
    );

    expect(view.reason.headline).toMatch(/^Recommended for your role/);
    expect(view.reason.detail).toBeNull();
    expect(view.reason.note).toBeNull();
  });

  it("an unrecognised source falls back to 'Assigned to you'", () => {
    const view = presentAssignment(
      item({ ...base, source: "SOMETHING_NEW", status: "ASSIGNED", reason: { x: 1 } })
    );

    expect(view.reason.headline).toBe("Assigned to you");
  });

  it("never leaks ids or admin fields from the reason into the presentation", () => {
    const view = presentAssignment(
      item(
        manual({
          reason: {
            assignedByName: "Alex",
            assignedById: "u_secret_admin",
            policyId: "pol_secret",
            note: "hi",
          },
        })
      )
    );

    const text = JSON.stringify(view);
    expect(text).not.toContain("u_secret_admin");
    expect(text).not.toContain("pol_secret");
  });
});

describe("formatDueDate", () => {
  it("formats the UTC calendar date so it matches the platform's end-of-day-UTC convention", () => {
    expect(formatDueDate("2027-03-01T23:59:59.999Z")).toBe("Mar 1, 2027");
    expect(formatDueDate("2027-12-31T00:00:00.000Z")).toBe("Dec 31, 2027");
  });

  it("returns null when there is no due date", () => {
    expect(formatDueDate(null)).toBeNull();
  });

  it("exposes the machine-readable value alongside the label", () => {
    const view = presentAssignment(item(manual({ dueDate: "2027-03-01T23:59:59.999Z" })));

    expect(view.due).toEqual({ label: "Mar 1, 2027", iso: "2027-03-01T23:59:59.999Z" });
    expect(presentAssignment(item(manual())).due).toBeNull();
  });
});

describe("formatDueDate — the intended calendar date in any viewer timezone", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const viewers = [
    ["Asia/Kolkata", "UTC+05:30"],
    ["Pacific/Kiritimati", "UTC+14, the furthest east"],
    ["Australia/Sydney", "UTC+10/+11"],
    ["UTC", "UTC"],
    ["America/New_York", "UTC-4/-5"],
    ["America/Los_Angeles", "UTC-7/-8"],
    ["Pacific/Pago_Pago", "UTC-11, the furthest west"],
  ] as const;

  const conventions = [
    ["end-of-day UTC, as the fixtures and reports store it", "2026-09-25T23:59:59.999Z"],
    ["UTC midnight, as a date input's YYYY-MM-DD is stored", "2026-09-25T00:00:00.000Z"],
    ["a noon UTC instant", "2026-09-25T12:00:00.000Z"],
  ] as const;

  const naive = (iso: string) =>
    new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  it.each(viewers)("%s (%s) sees 25 September for every stored convention", (zone) => {
    vi.stubEnv("TZ", zone);

    for (const [label, iso] of conventions) {
      expect(formatDueDate(iso), `${zone}: ${label}`).toBe("Sep 25, 2026");
    }
  });

  it("control: in Asia/Kolkata the viewer's own clock WOULD roll end-of-day UTC forward to the 26th", () => {
    vi.stubEnv("TZ", "Asia/Kolkata");

    expect(naive("2026-09-25T23:59:59.999Z")).toBe("Sep 26, 2026");
    expect(formatDueDate("2026-09-25T23:59:59.999Z")).toBe("Sep 25, 2026");
  });

  it("control: in Los Angeles the viewer's own clock WOULD roll UTC midnight back to the 24th", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");

    expect(naive("2026-09-25T00:00:00.000Z")).toBe("Sep 24, 2026");
    expect(formatDueDate("2026-09-25T00:00:00.000Z")).toBe("Sep 25, 2026");
  });

  it("does not depend on the process timezone at all", () => {
    const results = viewers.map(([zone]) => {
      vi.stubEnv("TZ", zone);
      return formatDueDate("2026-12-31T23:59:59.999Z");
    });

    expect(new Set(results)).toEqual(new Set(["Dec 31, 2026"]));
  });

  it("handles month, year and leap-day boundaries", () => {
    vi.stubEnv("TZ", "Asia/Kolkata");

    expect(formatDueDate("2027-01-01T00:00:00.000Z")).toBe("Jan 1, 2027");
    expect(formatDueDate("2028-02-29T23:59:59.999Z")).toBe("Feb 29, 2028");
    expect(formatDueDate("2026-09-30T23:59:59.999Z")).toBe("Sep 30, 2026");
  });

  it("the card's due label is the intended date for an Indian learner", () => {
    vi.stubEnv("TZ", "Asia/Kolkata");

    const view = presentAssignment(item(manual({ dueDate: "2026-09-25T23:59:59.999Z" })));

    expect(view.due).toEqual({ label: "Sep 25, 2026", iso: "2026-09-25T23:59:59.999Z" });
  });
});

describe("presentProgress — L-5: status stays authoritative, the UI never invents progress", () => {
  it("shows no bar for ASSIGNED, whatever number is supplied", () => {
    expect(presentProgress("ASSIGNED", 40)).toBeNull();
  });

  it("shows no bar for COMPLETED (the status already says it all)", () => {
    expect(presentProgress("COMPLETED", 100)).toBeNull();
  });

  it("shows no bar when the dashboard has no figure for the course", () => {
    expect(presentProgress("STARTED", undefined)).toBeNull();
    expect(presentProgress("OVERDUE", undefined)).toBeNull();
  });

  it("shows the same percentage the rest of the dashboard shows", () => {
    expect(presentProgress("STARTED", 42)).toEqual({ percent: 42, caveat: null });
    expect(presentProgress("OVERDUE", 10)).toEqual({ percent: 10, caveat: null });
  });

  it("STARTED at 0% explains that only published lessons are counted", () => {
    const progress = presentProgress("STARTED", 0);

    expect(progress?.percent).toBe(0);
    expect(progress?.caveat).toBe("Progress counts only lessons that are currently published.");
  });

  it("OVERDUE at 0% is not claimed to be started, so it carries no caveat", () => {
    expect(presentProgress("OVERDUE", 0)).toEqual({ percent: 0, caveat: null });
  });

  it("clamps and rounds out-of-range values instead of rendering them", () => {
    expect(presentProgress("STARTED", 140)?.percent).toBe(100);
    expect(presentProgress("STARTED", -5)?.percent).toBe(0);
    expect(presentProgress("STARTED", 33.6)?.percent).toBe(34);
    expect(presentProgress("STARTED", Number.NaN)).toBeNull();
  });
});

describe("loadAssignedLearning", () => {
  it("requests exactly the session-scoped endpoint: no identity in the URL, GET only", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { assignments: [] }));

    await loadAssignedLearning(fetchMock);

    expect(ASSIGNMENTS_ENDPOINT).toBe("/api/assignments/me");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/assignments/me");
    expect(String(url)).not.toMatch(/[?&]|userId|tenantId/);
    expect(init?.method ?? "GET").toBe("GET");
    expect(init?.body).toBeUndefined();
  });

  it("returns the parsed assignments on success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { assignments: [manual({ id: "x" })] }));

    const result = await loadAssignedLearning(fetchMock);

    expect(result.kind).toBe("ready");
    expect(result.kind === "ready" && result.assignments.map((a) => a.id)).toEqual(["x"]);
  });

  it("treats 400 (a learner with no organisation) as nothing assigned, not as a failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(400, { error: "No organisation found" }));

    expect(await loadAssignedLearning(fetchMock)).toEqual({ kind: "ready", assignments: [] });
  });

  it.each([401, 403, 404, 500, 503])("treats HTTP %s as an error", async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(status, { error: "x" }));

    expect(await loadAssignedLearning(fetchMock)).toEqual({ kind: "error" });
  });

  it("treats a network failure as an error without throwing", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    expect(await loadAssignedLearning(fetchMock)).toEqual({ kind: "error" });
  });

  it("treats an unreadable body as an error without throwing", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    });

    expect(await loadAssignedLearning(fetchMock)).toEqual({ kind: "error" });
  });

  it("treats a well-formed response with the wrong shape as an error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { unexpected: true }));

    expect(await loadAssignedLearning(fetchMock)).toEqual({ kind: "error" });
  });

  it("never surfaces the server's error text", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(500, { error: 'relation "LearningAssignment" does not exist' })
      );

    const result = await loadAssignedLearning(fetchMock);

    expect(JSON.stringify(result)).not.toContain("LearningAssignment");
  });

  it("forwards the abort signal so an unmounted section can cancel its request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { assignments: [] }));
    const controller = new AbortController();

    await loadAssignedLearning(fetchMock, controller.signal);

    expect(fetchMock.mock.calls[0][1]?.signal).toBe(controller.signal);
  });
});
