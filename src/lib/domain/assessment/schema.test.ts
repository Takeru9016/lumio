import { describe, expect, it } from "vitest";
import { buildAssessmentDraftSchema } from "@/lib/domain/assessment/schema";

describe("buildAssessmentDraftSchema", () => {
  it("accepts a valid draft within range", () => {
    const schema = buildAssessmentDraftSchema(100);
    const result = schema.safeParse({
      suggestedScore: 80,
      feedback: "Good.",
      rationale: "Because.",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a negative score", () => {
    const schema = buildAssessmentDraftSchema(100);
    const result = schema.safeParse({ suggestedScore: -1, feedback: "x", rationale: "y" });
    expect(result.success).toBe(false);
  });

  it("rejects a score above the given maxScore", () => {
    const schema = buildAssessmentDraftSchema(50);
    const result = schema.safeParse({ suggestedScore: 51, feedback: "x", rationale: "y" });
    expect(result.success).toBe(false);
  });

  it("accepts a score exactly at maxScore", () => {
    const schema = buildAssessmentDraftSchema(50);
    const result = schema.safeParse({ suggestedScore: 50, feedback: "x", rationale: "y" });
    expect(result.success).toBe(true);
  });

  it("rejects a non-integer score", () => {
    const schema = buildAssessmentDraftSchema(100);
    const result = schema.safeParse({ suggestedScore: 55.5, feedback: "x", rationale: "y" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty feedback string", () => {
    const schema = buildAssessmentDraftSchema(100);
    const result = schema.safeParse({ suggestedScore: 10, feedback: "", rationale: "y" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty rationale string", () => {
    const schema = buildAssessmentDraftSchema(100);
    const result = schema.safeParse({ suggestedScore: 10, feedback: "x", rationale: "" });
    expect(result.success).toBe(false);
  });

  it("rejects an unexpected extra field (.strict())", () => {
    const schema = buildAssessmentDraftSchema(100);
    const result = schema.safeParse({
      suggestedScore: 10,
      feedback: "x",
      rationale: "y",
      isPassed: true,
    });
    expect(result.success).toBe(false);
  });
});
