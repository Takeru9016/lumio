import { describe, expect, it } from "vitest";
import { derivePathProgress } from "@/lib/domain/learning-path/progress";

type Input = Parameters<typeof derivePathProgress>[0][number];

let n = 0;
const member = (over: Partial<Input> = {}): Input => {
  n += 1;
  return {
    courseId: `c-${n}`,
    status: "PUBLISHED",
    hasPublishedLesson: true,
    enrollmentStatus: null,
    ...over,
  };
};

const completed = (over: Partial<Input> = {}) => member({ enrollmentStatus: "COMPLETED", ...over });

describe("derivePathProgress", () => {
  it("a zero denominator is null progress and never complete (empty path)", () => {
    expect(derivePathProgress([])).toEqual({
      members: [],
      completed: 0,
      total: 0,
      percent: null,
      complete: false,
    });
  });

  it("a zero denominator is null progress and never complete (everything unavailable)", () => {
    const result = derivePathProgress([
      member({ status: "DRAFT" }),
      member({ status: "ARCHIVED" }),
      member({ hasPublishedLesson: false }),
    ]);

    expect(result).toMatchObject({ completed: 0, total: 0, percent: null, complete: false });
    expect(result.members.map((x) => x.state)).toEqual([
      "UNAVAILABLE",
      "UNAVAILABLE",
      "UNAVAILABLE",
    ]);
  });

  it("all completed is 100% and complete", () => {
    const result = derivePathProgress([completed(), completed(), completed()]);

    expect(result).toMatchObject({ completed: 3, total: 3, percent: 100, complete: true });
  });

  it("completed plus available is completed / (completed + available)", () => {
    const result = derivePathProgress([completed(), member(), member(), completed()]);

    expect(result).toMatchObject({ completed: 2, total: 4, percent: 50, complete: false });
    expect(result.members.map((x) => x.state)).toEqual([
      "COMPLETED",
      "AVAILABLE",
      "AVAILABLE",
      "COMPLETED",
    ]);
  });

  it("rounds to a whole percent", () => {
    expect(derivePathProgress([completed(), member(), member()]).percent).toBe(33);
    expect(derivePathProgress([completed(), completed(), member()]).percent).toBe(67);
  });

  it("unavailable members leave the denominator: they neither help nor hurt", () => {
    const result = derivePathProgress([
      completed(),
      member(),
      member({ status: "DRAFT" }),
      member({ status: "ARCHIVED" }),
      member({ hasPublishedLesson: false }),
    ]);

    expect(result).toMatchObject({ completed: 1, total: 2, percent: 50 });
  });

  it("finishing every available course completes the path even with unavailable members", () => {
    const result = derivePathProgress([completed(), member({ status: "ARCHIVED" })]);

    expect(result).toMatchObject({ completed: 1, total: 1, percent: 100, complete: true });
  });

  it("an ACTIVE enrollment does not count as completed; the course is available", () => {
    const result = derivePathProgress([member({ enrollmentStatus: "ACTIVE" }), completed()]);

    expect(result).toMatchObject({ completed: 1, total: 2, percent: 50 });
    expect(result.members[0].state).toBe("AVAILABLE");
  });

  it("a REFUNDED enrollment does not count as completed; the course is available", () => {
    const result = derivePathProgress([member({ enrollmentStatus: "REFUNDED" }), completed()]);

    expect(result).toMatchObject({ completed: 1, total: 2, percent: 50 });
    expect(result.members[0].state).toBe("AVAILABLE");
  });

  it("no enrollment at all is available, not completed", () => {
    expect(derivePathProgress([member()]).members[0].state).toBe("AVAILABLE");
  });

  it.each([
    ["archived", { status: "ARCHIVED" as const }],
    ["a draft", { status: "DRAFT" as const }],
    ["without a published lesson", { hasPublishedLesson: false }],
  ])(
    "completed outranks retirement: a course completed and then %s still counts, as completed",
    (_n, over) => {
      const result = derivePathProgress([completed(over), member()]);

      expect(result).toMatchObject({ completed: 1, total: 2, percent: 50 });
      expect(result.members[0].state).toBe("COMPLETED");
    }
  );

  it("an ACTIVE or REFUNDED enrollment on a retired course stays unavailable", () => {
    const result = derivePathProgress([
      member({ status: "ARCHIVED", enrollmentStatus: "ACTIVE" }),
      member({ status: "DRAFT", enrollmentStatus: "REFUNDED" }),
    ]);

    expect(result.members.map((x) => x.state)).toEqual(["UNAVAILABLE", "UNAVAILABLE"]);
    expect(result.total).toBe(0);
  });

  it("keeps the input order and identifies each member by course id only", () => {
    const a = completed();
    const b = member();
    const result = derivePathProgress([b, a]);

    expect(result.members).toEqual([
      { courseId: b.courseId, state: "AVAILABLE" },
      { courseId: a.courseId, state: "COMPLETED" },
    ]);
  });

  it("is pure: the same input gives the same answer and the input is untouched", () => {
    const input = [completed(), member()];
    const snapshot = JSON.stringify(input);

    expect(derivePathProgress(input)).toEqual(derivePathProgress(input));
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
