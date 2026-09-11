import { describe, expect, it } from "vitest";
import {
  compareProficiency,
  isAtLeast,
  maxProficiency,
  PROFICIENCY_ORDER,
} from "@/lib/domain/capability/proficiencyOrder";

describe("PROFICIENCY_ORDER", () => {
  it("orders NONE < BEGINNER < INTERMEDIATE < ADVANCED < EXPERT", () => {
    expect(PROFICIENCY_ORDER).toEqual(["NONE", "BEGINNER", "INTERMEDIATE", "ADVANCED", "EXPERT"]);
  });
});

describe("compareProficiency", () => {
  it("returns -1 when a < b", () => {
    expect(compareProficiency("BEGINNER", "INTERMEDIATE")).toBe(-1);
    expect(compareProficiency("NONE", "EXPERT")).toBe(-1);
  });
  it("returns 0 when equal", () => {
    expect(compareProficiency("INTERMEDIATE", "INTERMEDIATE")).toBe(0);
  });
  it("returns 1 when a > b", () => {
    expect(compareProficiency("ADVANCED", "BEGINNER")).toBe(1);
    expect(compareProficiency("EXPERT", "NONE")).toBe(1);
  });
});

describe("isAtLeast", () => {
  it("true when strictly above threshold", () =>
    expect(isAtLeast("INTERMEDIATE", "BEGINNER")).toBe(true));
  it("true when exactly at threshold", () => expect(isAtLeast("BEGINNER", "BEGINNER")).toBe(true));
  it("false when below threshold", () => expect(isAtLeast("NONE", "BEGINNER")).toBe(false));
});

describe("maxProficiency", () => {
  it("returns NONE for an empty array", () => {
    expect(maxProficiency([])).toBe("NONE");
  });

  it("returns the highest value regardless of array order", () => {
    expect(maxProficiency(["BEGINNER", "EXPERT", "NONE"])).toBe("EXPERT");
    expect(maxProficiency(["EXPERT", "BEGINNER", "NONE"])).toBe("EXPERT");
    expect(maxProficiency(["NONE", "NONE", "EXPERT"])).toBe("EXPERT");
  });

  it("is order-independent for a tie at the maximum", () => {
    expect(maxProficiency(["INTERMEDIATE", "INTERMEDIATE", "BEGINNER"])).toBe("INTERMEDIATE");
    expect(maxProficiency(["BEGINNER", "INTERMEDIATE", "INTERMEDIATE"])).toBe("INTERMEDIATE");
  });
});
