import { describe, expect, it } from "vitest";
import { parseAddCourseInput, parseReorderInput } from "@/lib/domain/learning-path/inputRules";
import { LearningPathError } from "@/lib/domain/learning-path/types";

function codeOf(call: () => unknown): string | null {
  try {
    call();
    return null;
  } catch (err) {
    return err instanceof LearningPathError ? err.code : `UNEXPECTED:${String(err)}`;
  }
}

describe("parseAddCourseInput", () => {
  it("takes the course id and nothing else", () => {
    expect(parseAddCourseInput({ courseId: "course_1-a" })).toEqual({ courseId: "course_1-a" });
  });

  it.each([
    [{}],
    [{ courseId: "" }],
    [{ courseId: 5 }],
    [{ courseId: null }],
    [{ courseId: "a b" }],
    [{ courseId: "a\u0000b" }],
    [{ courseId: "x".repeat(200) }],
    [{ courseId: "ok", position: 1 }],
    [{ courseId: "ok", tenantId: "t" }],
    [{ courseId: "ok", createdById: "u" }],
    [{ courseId: "ok", status: "PUBLISHED" }],
    [{ courseId: "ok", publishedAt: null }],
    [{ courseId: "ok", id: "i" }],
    [{ courseIds: ["ok"] }],
    [null],
    [undefined],
    ["ok"],
    [["ok"]],
  ])("refuses %j", (body) => {
    expect(codeOf(() => parseAddCourseInput(body))).toBe("INVALID_INPUT");
  });
});

describe("parseReorderInput", () => {
  it("hands the list on for planReorder to check against the path, whatever it holds", () => {
    expect(parseReorderInput({ courseIds: ["a", "b"] })).toEqual({ courseIds: ["a", "b"] });
    expect(parseReorderInput({ courseIds: "not a list" })).toEqual({ courseIds: "not a list" });
    expect(parseReorderInput({ courseIds: null })).toEqual({ courseIds: null });
  });

  it.each([
    [{}],
    [{ courseIds: ["a"], positions: [1] }],
    [{ courseIds: ["a"], tenantId: "t" }],
    [{ positions: [1] }],
    [{ courseId: "a" }],
    [null],
    [undefined],
    ["a"],
    [["a"]],
  ])("refuses %j", (body) => {
    expect(codeOf(() => parseReorderInput(body))).toBe("INVALID_INPUT");
  });
});
