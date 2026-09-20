import { describe, expect, it } from "vitest";
import {
  capabilityGapSourceKey,
  mandatorySourceKey,
  manualSourceKey,
} from "@/lib/domain/learning-assignment/sourceKeys";

describe("assignment source keys", () => {
  it("builds a manual key that is specific to the course", () => {
    expect(manualSourceKey("course-1")).toBe("manual:course-1");
    expect(manualSourceKey("course-1")).not.toBe(manualSourceKey("course-2"));
  });

  it("builds a mandatory key from the mandatory training id", () => {
    expect(mandatorySourceKey("mt-1")).toBe("mandatory:mt-1");
  });

  it("builds a capability-gap key from both the role and the skill", () => {
    expect(capabilityGapSourceKey("role-1", "skill-1")).toBe("gap:role-1:skill-1");
  });

  it("does not collapse gaps that share a role but not a skill", () => {
    expect(capabilityGapSourceKey("role-1", "skill-1")).not.toBe(
      capabilityGapSourceKey("role-1", "skill-2")
    );
  });

  it("does not collapse gaps that share a skill but not a role", () => {
    expect(capabilityGapSourceKey("role-1", "skill-1")).not.toBe(
      capabilityGapSourceKey("role-2", "skill-1")
    );
  });

  it("never produces the same key across two sources", () => {
    const keys = [manualSourceKey("x"), mandatorySourceKey("x"), capabilityGapSourceKey("x", "x")];
    expect(new Set(keys).size).toBe(3);
  });
});
