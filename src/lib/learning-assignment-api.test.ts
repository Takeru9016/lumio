import { describe, expect, it, vi } from "vitest";
import { AuthContextError } from "@/lib/auth/context";
import type { AssignmentSkipReason } from "@/lib/domain/learning-assignment/types";
import {
  cancelFailureResponse,
  errorResponse,
  parseDueDateInput,
  skipResponse,
} from "@/lib/learning-assignment-api";

const ALL_SKIP_REASONS: AssignmentSkipReason[] = [
  "INVALID_INPUT",
  "LEARNER_NOT_ELIGIBLE",
  "COURSE_NOT_FOUND",
  "COURSE_NOT_PUBLISHED",
  "COURSE_REQUIRES_PAYMENT",
  "ENROLLMENT_REFUNDED",
  "ASSIGNMENT_CONFLICT",
  "MANDATORY_TRAINING_NOT_FOUND",
  "LEARNER_NOT_IN_TEAM",
  "GAP_NOT_FOUND",
  "GAP_ALREADY_MET",
  "COURSE_DOES_NOT_ADDRESS_SKILL",
];

describe("parseDueDateInput", () => {
  it("omitted leaves the due date alone, null clears it", () => {
    expect(parseDueDateInput(undefined)).toEqual({ ok: true, value: undefined });
    expect(parseDueDateInput(null)).toEqual({ ok: true, value: null });
  });

  it("a calendar date becomes the END of that day in UTC", () => {
    expect(parseDueDateInput("2027-03-01")).toEqual({
      ok: true,
      value: new Date("2027-03-01T23:59:59.999Z"),
    });
  });

  it("accepts a leap day only in a leap year", () => {
    expect(parseDueDateInput("2028-02-29")).toEqual({
      ok: true,
      value: new Date("2028-02-29T23:59:59.999Z"),
    });
    expect(parseDueDateInput("2027-02-29")).toEqual({ ok: false });
  });

  it.each(["2026-02-31", "2026-04-31", "2026-13-01", "2026-00-10", "2026-01-32", "0000-00-00"])(
    "rejects the impossible date %s instead of letting it roll into another day",
    (value) => {
      expect(parseDueDateInput(value)).toEqual({ ok: false });
    }
  );

  it("accepts a full ISO instant as given", () => {
    expect(parseDueDateInput("2027-03-01T12:30:00.000Z")).toEqual({
      ok: true,
      value: new Date("2027-03-01T12:30:00.000Z"),
    });
  });

  it.each([
    "",
    "tomorrow",
    "03/01/2027",
    "2027-3-1",
    "2027-03-01 10:00",
    "T",
    20270301,
    {},
    [],
    true,
  ])("rejects the unparseable value %j", (value) => {
    expect(parseDueDateInput(value)).toEqual({ ok: false });
  });

  it("does not decide whether a past or far-future date is acceptable (that is the domain's, and L-4 is unchanged)", () => {
    expect(parseDueDateInput("2001-01-01").ok).toBe(true);
    expect(parseDueDateInput("2099-12-31").ok).toBe(true);
  });
});

describe("skipResponse", () => {
  it("has a status and prose for every domain skip reason", async () => {
    for (const reason of ALL_SKIP_REASONS) {
      const res = skipResponse(reason);
      const body = (await res.json()) as { error: string };

      expect([400, 404, 409, 422], reason).toContain(res.status);
      expect(body.error.length, reason).toBeGreaterThan(10);
    }
  });

  it("never echoes the reason's name, an id or database wording", async () => {
    for (const reason of ALL_SKIP_REASONS) {
      const text = JSON.stringify(await skipResponse(reason).json());

      expect(text, reason).not.toContain(reason);
      expect(text, reason).not.toMatch(/_[A-Z]+_|prisma|constraint|tenant|unique/i);
    }
  });

  it("uses the expected statuses for the cases that matter", () => {
    const status = (r: AssignmentSkipReason) => skipResponse(r).status;

    expect(status("INVALID_INPUT")).toBe(400);
    expect(status("LEARNER_NOT_ELIGIBLE")).toBe(404);
    expect(status("COURSE_NOT_FOUND")).toBe(404);
    expect(status("COURSE_NOT_PUBLISHED")).toBe(422);
    expect(status("COURSE_REQUIRES_PAYMENT")).toBe(422);
    expect(status("ENROLLMENT_REFUNDED")).toBe(409);
    expect(status("ASSIGNMENT_CONFLICT")).toBe(409);
  });
});

describe("cancelFailureResponse", () => {
  it("404 when missing (or another tenant's), 409 when completed", async () => {
    const missing = cancelFailureResponse("ASSIGNMENT_NOT_FOUND");
    const completed = cancelFailureResponse("ASSIGNMENT_COMPLETED");

    expect(missing.status).toBe(404);
    expect(completed.status).toBe(409);
    expect(JSON.stringify(await completed.json())).toMatch(/completed/);
  });
});

describe("errorResponse", () => {
  it("passes an auth failure through with its own status and message", async () => {
    const res = errorResponse(new AuthContextError(403, "Forbidden"), "x", "public");

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("answers anything else with the generic message and logs the detail server-side only", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = errorResponse(
      new Error('duplicate key value violates unique constraint "LearningAssignment_pkey"'),
      "Failed to create",
      "Couldn't assign that course. Please try again."
    );
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: "Couldn't assign that course. Please try again." });
    expect(text).not.toContain("LearningAssignment_pkey");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
