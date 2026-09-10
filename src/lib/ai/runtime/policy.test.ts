import { describe, expect, it } from "vitest";
import { assertActionAllowed, isActionAllowed } from "@/lib/ai/runtime/policy";
import type { AISurface } from "@/lib/ai/runtime/types";
import { AIRuntimeError } from "@/lib/ai/runtime/types";

describe("AI policy — TUTOR", () => {
  it("allows READ", () => expect(isActionAllowed("TUTOR", "READ")).toBe(true));
  it("allows GENERATE", () => expect(isActionAllowed("TUTOR", "GENERATE")).toBe(true));
  it("denies WRITE", () => expect(isActionAllowed("TUTOR", "WRITE")).toBe(false));
  it("denies EXECUTE", () => expect(isActionAllowed("TUTOR", "EXECUTE")).toBe(false));
});

describe("AI policy — COURSE_CREATOR", () => {
  it("allows READ", () => expect(isActionAllowed("COURSE_CREATOR", "READ")).toBe(true));
  it("allows GENERATE", () => expect(isActionAllowed("COURSE_CREATOR", "GENERATE")).toBe(true));
  it("denies WRITE", () => expect(isActionAllowed("COURSE_CREATOR", "WRITE")).toBe(false));
  it("denies EXECUTE", () => expect(isActionAllowed("COURSE_CREATOR", "EXECUTE")).toBe(false));
});

describe("AI policy — every surface denies WRITE and EXECUTE", () => {
  const surfaces: AISurface[] = ["TUTOR", "SEARCH", "COURSE_CREATOR", "COPILOT"];
  for (const surface of surfaces) {
    it(`${surface} denies WRITE`, () => expect(isActionAllowed(surface, "WRITE")).toBe(false));
    it(`${surface} denies EXECUTE`, () => expect(isActionAllowed(surface, "EXECUTE")).toBe(false));
  }
});

describe("AI policy — fail closed", () => {
  it("denies every action for an unrecognized surface", () => {
    const bogus = "NOT_A_REAL_SURFACE" as AISurface;
    expect(isActionAllowed(bogus, "READ")).toBe(false);
    expect(isActionAllowed(bogus, "GENERATE")).toBe(false);
    expect(isActionAllowed(bogus, "WRITE")).toBe(false);
    expect(isActionAllowed(bogus, "EXECUTE")).toBe(false);
  });

  it("assertActionAllowed throws AIRuntimeError with category POLICY_DENIED", () => {
    expect(() => assertActionAllowed("TUTOR", "WRITE")).toThrow(AIRuntimeError);
    let caught: unknown;
    try {
      assertActionAllowed("TUTOR", "WRITE");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AIRuntimeError);
    expect((caught as InstanceType<typeof AIRuntimeError>).category).toBe("POLICY_DENIED");
  });

  it("assertActionAllowed does not throw for an allowed action", () => {
    expect(() => assertActionAllowed("TUTOR", "READ")).not.toThrow();
  });
});
