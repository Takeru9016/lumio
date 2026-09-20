import { describe, expect, it } from "vitest";
import { deriveAssignmentStatus } from "@/lib/domain/learning-assignment/status";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const PAST = new Date("2026-09-30T12:00:00.000Z");
const FUTURE = new Date("2026-10-02T12:00:00.000Z");

const base = {
  cancelledAt: null,
  dueDate: null,
  enrollmentStatus: "ACTIVE" as const,
  hasLessonProgress: false,
  now: NOW,
};

describe("deriveAssignmentStatus", () => {
  it("is ASSIGNED for an active enrollment with no progress and no due date", () => {
    expect(deriveAssignmentStatus(base)).toBe("ASSIGNED");
  });

  it("is ASSIGNED when the due date is still in the future", () => {
    expect(deriveAssignmentStatus({ ...base, dueDate: FUTURE })).toBe("ASSIGNED");
  });

  it("is ASSIGNED when the learner has no enrollment row at all", () => {
    expect(deriveAssignmentStatus({ ...base, enrollmentStatus: null })).toBe("ASSIGNED");
  });

  it("is STARTED once any lesson progress row exists", () => {
    expect(deriveAssignmentStatus({ ...base, hasLessonProgress: true })).toBe("STARTED");
  });

  it("is STARTED when progress exists and the due date is in the future", () => {
    expect(deriveAssignmentStatus({ ...base, hasLessonProgress: true, dueDate: FUTURE })).toBe(
      "STARTED"
    );
  });

  it("is OVERDUE when the due date has passed and the enrollment is not completed", () => {
    expect(deriveAssignmentStatus({ ...base, dueDate: PAST })).toBe("OVERDUE");
  });

  it("is OVERDUE, not STARTED, when progress exists but the due date has passed", () => {
    expect(deriveAssignmentStatus({ ...base, hasLessonProgress: true, dueDate: PAST })).toBe(
      "OVERDUE"
    );
  });

  it("is not overdue at the exact due instant", () => {
    expect(deriveAssignmentStatus({ ...base, dueDate: NOW })).toBe("ASSIGNED");
  });

  it("is COMPLETED for a completed enrollment", () => {
    expect(deriveAssignmentStatus({ ...base, enrollmentStatus: "COMPLETED" })).toBe("COMPLETED");
  });

  it("is COMPLETED, not OVERDUE, when completed after the due date", () => {
    expect(deriveAssignmentStatus({ ...base, enrollmentStatus: "COMPLETED", dueDate: PAST })).toBe(
      "COMPLETED"
    );
  });

  it("is COMPLETED, not STARTED, when completed with progress", () => {
    expect(
      deriveAssignmentStatus({ ...base, enrollmentStatus: "COMPLETED", hasLessonProgress: true })
    ).toBe("COMPLETED");
  });

  it("is CANCELLED when cancelledAt is set", () => {
    expect(deriveAssignmentStatus({ ...base, cancelledAt: PAST })).toBe("CANCELLED");
  });

  it("CANCELLED takes precedence over COMPLETED, OVERDUE and STARTED", () => {
    expect(
      deriveAssignmentStatus({
        ...base,
        cancelledAt: PAST,
        enrollmentStatus: "COMPLETED",
        dueDate: PAST,
        hasLessonProgress: true,
      })
    ).toBe("CANCELLED");
  });

  it("does not treat a REFUNDED enrollment as completed", () => {
    expect(deriveAssignmentStatus({ ...base, enrollmentStatus: "REFUNDED" })).toBe("ASSIGNED");
  });

  it("does not depend on the wall clock", () => {
    expect(
      deriveAssignmentStatus({ ...base, dueDate: PAST, now: new Date("2026-09-29T00:00:00Z") })
    ).toBe("ASSIGNED");
  });
});
