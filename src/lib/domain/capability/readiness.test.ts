import { describe, expect, it } from "vitest";
import type { SkillProficiency } from "@/generated/prisma/client";
import { PROFICIENCY_ORDER } from "@/lib/domain/capability/proficiencyOrder";
import { MAX_GRANTABLE_LEVEL } from "@/lib/domain/capability/proficiencyPolicy";
import { evaluateRequirement } from "@/lib/domain/capability/readiness";

describe("evaluateRequirement — contract §G2", () => {
  it("MET: current equals required", () => {
    expect(evaluateRequirement("BEGINNER", "BEGINNER")).toEqual({
      requiredProficiency: "BEGINNER",
      currentProficiency: "BEGINNER",
      status: "MET",
      levelsShort: 0,
    });
  });

  it("MET: current above required", () => {
    expect(evaluateRequirement("BEGINNER", "INTERMEDIATE")).toMatchObject({
      status: "MET",
      levelsShort: 0,
    });
  });

  it("MISSING: no evidence at all, requirement above NONE and assessable", () => {
    expect(evaluateRequirement("BEGINNER", "NONE")).toEqual({
      requiredProficiency: "BEGINNER",
      currentProficiency: "NONE",
      status: "MISSING",
      levelsShort: 1,
    });
  });

  it("BELOW: some evidence, still short of an assessable requirement", () => {
    expect(evaluateRequirement("INTERMEDIATE", "BEGINNER")).toEqual({
      requiredProficiency: "INTERMEDIATE",
      currentProficiency: "BEGINNER",
      status: "BELOW",
      levelsShort: 1,
    });
  });

  it("levelsShort is the exact ordinal distance, not just 1 — MISSING two levels short", () => {
    expect(evaluateRequirement("INTERMEDIATE", "NONE").levelsShort).toBe(
      PROFICIENCY_ORDER.indexOf("INTERMEDIATE") - PROFICIENCY_ORDER.indexOf("NONE")
    );
  });

  describe("NOT_ASSESSABLE — derived from the policy's ceiling, never a hard-coded level name", () => {
    const unassessableLevels = PROFICIENCY_ORDER.filter(
      (level) => PROFICIENCY_ORDER.indexOf(level) > PROFICIENCY_ORDER.indexOf(MAX_GRANTABLE_LEVEL)
    );

    it("at least one level is currently unassessable (sanity: the test below is not vacuous)", () => {
      expect(unassessableLevels.length).toBeGreaterThan(0);
    });

    it.each(unassessableLevels)(
      "required=%s, current=NONE -> NOT_ASSESSABLE, not MISSING",
      (level) => {
        expect(evaluateRequirement(level as SkillProficiency, "NONE")).toEqual({
          requiredProficiency: level,
          currentProficiency: "NONE",
          status: "NOT_ASSESSABLE",
          levelsShort: 0,
        });
      }
    );

    it.each(unassessableLevels)(
      "required=%s, current=BEGINNER -> still NOT_ASSESSABLE, not BELOW",
      (level) => {
        expect(evaluateRequirement(level as SkillProficiency, "BEGINNER").status).toBe(
          "NOT_ASSESSABLE"
        );
      }
    );
  });

  it("MET takes priority over NOT_ASSESSABLE — a learner who already meets an otherwise-unreachable requirement is MET, not NOT_ASSESSABLE", () => {
    const unassessable = PROFICIENCY_ORDER.find(
      (level) => PROFICIENCY_ORDER.indexOf(level) > PROFICIENCY_ORDER.indexOf(MAX_GRANTABLE_LEVEL)
    ) as SkillProficiency;
    expect(evaluateRequirement(unassessable, unassessable)).toMatchObject({ status: "MET" });
  });

  it("every level is assessed consistently against every other level (full matrix, no level name hard-coded in this test)", () => {
    for (const required of PROFICIENCY_ORDER) {
      for (const current of PROFICIENCY_ORDER) {
        const result = evaluateRequirement(required, current);
        const requiredIdx = PROFICIENCY_ORDER.indexOf(required);
        const currentIdx = PROFICIENCY_ORDER.indexOf(current);
        const ceilingIdx = PROFICIENCY_ORDER.indexOf(MAX_GRANTABLE_LEVEL);

        if (currentIdx >= requiredIdx) {
          expect(result.status).toBe("MET");
        } else if (requiredIdx > ceilingIdx) {
          expect(result.status).toBe("NOT_ASSESSABLE");
        } else if (current === "NONE") {
          expect(result.status).toBe("MISSING");
        } else {
          expect(result.status).toBe("BELOW");
        }
      }
    }
  });
});
