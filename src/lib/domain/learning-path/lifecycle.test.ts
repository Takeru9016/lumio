import { describe, expect, it } from "vitest";
import {
  assertPathEditable,
  assertTransition,
  canTransition,
  LEARNING_PATH_TRANSITIONS,
  transitionNeedsPublishability,
} from "@/lib/domain/learning-path/lifecycle";
import { LearningPathError, type LearningPathStatus } from "@/lib/domain/learning-path/types";

const STATUSES: LearningPathStatus[] = ["DRAFT", "PUBLISHED", "ARCHIVED"];

const ALLOWED: [LearningPathStatus, LearningPathStatus][] = [
  ["DRAFT", "PUBLISHED"],
  ["DRAFT", "ARCHIVED"],
  ["PUBLISHED", "ARCHIVED"],
  ["ARCHIVED", "PUBLISHED"],
];

const REJECTED: [LearningPathStatus, LearningPathStatus][] = [
  ["DRAFT", "DRAFT"],
  ["PUBLISHED", "PUBLISHED"],
  ["ARCHIVED", "ARCHIVED"],
  ["PUBLISHED", "DRAFT"],
  ["ARCHIVED", "DRAFT"],
];

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof LearningPathError) return err.code;
    throw err;
  }
  return "NO_ERROR";
}

describe("path lifecycle", () => {
  it("covers all nine (from, to) pairs exactly once", () => {
    expect(ALLOWED.length + REJECTED.length).toBe(STATUSES.length * STATUSES.length);
    const seen = new Set([...ALLOWED, ...REJECTED].map(([f, t]) => `${f}>${t}`));
    expect(seen.size).toBe(9);
  });

  it.each(ALLOWED)("%s -> %s is allowed", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(codeOf(() => assertTransition(from, to))).toBe("NO_ERROR");
  });

  it.each(REJECTED)("%s -> %s is INVALID_TRANSITION", (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(codeOf(() => assertTransition(from, to))).toBe("INVALID_TRANSITION");
  });

  it("nothing ever goes back to DRAFT: there is no unpublish", () => {
    for (const from of STATUSES) expect(LEARNING_PATH_TRANSITIONS[from]).not.toContain("DRAFT");
  });

  it("an unknown status is rejected, not treated as allowed", () => {
    expect(codeOf(() => assertTransition("DELETED" as never, "PUBLISHED"))).toBe(
      "INVALID_TRANSITION"
    );
    expect(codeOf(() => assertTransition("DRAFT", "DELETED" as never))).toBe("INVALID_TRANSITION");
  });

  it("only arriving at PUBLISHED needs the publishability check, including a republish", () => {
    expect(transitionNeedsPublishability("PUBLISHED")).toBe(true);
    expect(transitionNeedsPublishability("ARCHIVED")).toBe(false);
    expect(canTransition("ARCHIVED", "PUBLISHED")).toBe(true);
    expect(transitionNeedsPublishability("PUBLISHED")).toBe(true);
  });

  it("an ARCHIVED path is not editable; DRAFT and PUBLISHED are", () => {
    expect(codeOf(() => assertPathEditable("ARCHIVED"))).toBe("PATH_ARCHIVED");
    expect(codeOf(() => assertPathEditable("DRAFT"))).toBe("NO_ERROR");
    expect(codeOf(() => assertPathEditable("PUBLISHED"))).toBe("NO_ERROR");
  });
});
