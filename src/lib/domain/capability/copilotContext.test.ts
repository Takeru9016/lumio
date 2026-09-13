import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Unit test for buildCopilotContext — a thin composition layer over
 * computeCapabilityGap/getUserSkillState/getRecommendedLearning, each of
 * which already has its own real-DB test suite. Mocking those three here
 * (rather than a real-DB fixture setup) isolates what this function itself
 * is responsible for: call count, no-role handling, and shaping a bounded,
 * id-free context — not re-proving gap/recommendation correctness.
 */
vi.mock("@/lib/domain/capability/gaps", () => ({
  computeCapabilityGap: vi.fn(),
  getUserSkillState: vi.fn(),
}));

vi.mock("@/lib/domain/capability/recommendations", () => ({
  getRecommendedLearning: vi.fn(),
}));

const { computeCapabilityGap, getUserSkillState } = await import("@/lib/domain/capability/gaps");
const { getRecommendedLearning } = await import("@/lib/domain/capability/recommendations");
const { buildCopilotContext } = await import("@/lib/domain/capability/copilotContext");

const computeCapabilityGapMock = vi.mocked(computeCapabilityGap);
const getUserSkillStateMock = vi.mocked(getUserSkillState);
const getRecommendedLearningMock = vi.mocked(getRecommendedLearning);

const ctx = { userId: "u1", clerkId: "c1", tenantId: "t1", role: "STUDENT" as const };

afterEach(() => {
  vi.resetAllMocks();
});

describe("buildCopilotContext", () => {
  it("calls computeCapabilityGap, getUserSkillState, and getRecommendedLearning exactly once each, with ctx", async () => {
    computeCapabilityGapMock.mockResolvedValue({ role: { id: "r1", name: "Sales Rep" }, gaps: [] });
    getUserSkillStateMock.mockResolvedValue([]);
    getRecommendedLearningMock.mockResolvedValue({ recommendations: [] });

    await buildCopilotContext(ctx);

    expect(computeCapabilityGapMock).toHaveBeenCalledTimes(1);
    expect(computeCapabilityGapMock).toHaveBeenCalledWith(ctx);
    expect(getUserSkillStateMock).toHaveBeenCalledTimes(1);
    expect(getUserSkillStateMock).toHaveBeenCalledWith(ctx);
    expect(getRecommendedLearningMock).toHaveBeenCalledTimes(1);
    expect(getRecommendedLearningMock).toHaveBeenCalledWith(ctx);
  });

  it("represents a learner with no primary role honestly, without fabricating one", async () => {
    computeCapabilityGapMock.mockResolvedValue({ role: null, gaps: [] });
    getUserSkillStateMock.mockResolvedValue([]);
    getRecommendedLearningMock.mockResolvedValue({ recommendations: [] });

    const result = await buildCopilotContext(ctx);

    expect(result).toEqual({
      hasPrimaryRole: false,
      roleName: null,
      requiredSkills: [],
      recommendedCourses: [],
    });
  });

  it("builds bounded required-skill and recommended-course context from the mocked domain outputs", async () => {
    computeCapabilityGapMock.mockResolvedValue({
      role: { id: "r1", name: "Sales Rep" },
      gaps: [
        {
          skillId: "s1",
          skillName: "Negotiation",
          requiredProficiency: "INTERMEDIATE",
          currentProficiency: "BEGINNER",
          met: false,
        },
      ],
    } as never);
    getUserSkillStateMock.mockResolvedValue([
      { skillId: "s1", skillName: "Negotiation", proficiency: "BEGINNER", lastAssessedAt: null },
    ] as never);
    getRecommendedLearningMock.mockResolvedValue({
      recommendations: [
        {
          courseId: "c1",
          courseTitle: "Negotiation 101",
          courseSlug: "negotiation-101",
          reasonSkills: [
            {
              skillId: "s1",
              skillName: "Negotiation",
              requiredProficiency: "INTERMEDIATE",
              currentProficiency: "BEGINNER",
            },
          ],
        },
      ],
    } as never);

    const result = await buildCopilotContext(ctx);

    expect(result).toEqual({
      hasPrimaryRole: true,
      roleName: "Sales Rep",
      requiredSkills: [
        {
          skillName: "Negotiation",
          requiredProficiency: "INTERMEDIATE",
          currentProficiency: "BEGINNER",
          met: false,
        },
      ],
      recommendedCourses: [
        {
          courseTitle: "Negotiation 101",
          reasonSkills: [
            {
              skillName: "Negotiation",
              requiredProficiency: "INTERMEDIATE",
              currentProficiency: "BEGINNER",
            },
          ],
        },
      ],
    });
    // No internal ids (skillId/courseId/roleId) leak into the bounded context.
    expect(JSON.stringify(result)).not.toMatch(/"s1"|"c1"|"r1"/);
  });

  it("falls back to the gap's own current proficiency when no matching UserSkill row exists", async () => {
    computeCapabilityGapMock.mockResolvedValue({
      role: { id: "r1", name: "Sales Rep" },
      gaps: [
        {
          skillId: "s1",
          skillName: "Negotiation",
          requiredProficiency: "BEGINNER",
          currentProficiency: "NONE",
          met: false,
        },
      ],
    } as never);
    getUserSkillStateMock.mockResolvedValue([]); // no UserSkill rows at all
    getRecommendedLearningMock.mockResolvedValue({ recommendations: [] });

    const result = await buildCopilotContext(ctx);

    expect(result.requiredSkills[0].currentProficiency).toBe("NONE");
  });

  it("never queries or references SkillEvidence, and never imports the generic AI context builder, Knowledge retrieval, or db directly", () => {
    // Regex on actual import syntax / call sites, not a plain substring — the
    // file's own doc comments legitimately name SkillEvidence/buildAIContext
    // in prose to explain why they're absent (Phase 11's instructorReport.ts
    // precedent for why a naive substring check false-fails against such
    // comments). Not importing "@/lib/db" at all is the structural proof
    // this function cannot query SkillEvidence — there's no db handle here.
    const source = readFileSync(new URL("./copilotContext.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/db\.skillEvidence/i);
    expect(source).not.toMatch(/from ["']@\/lib\/db["']/);
    expect(source).not.toMatch(/from ["']@\/lib\/ai\/runtime\/context["']/);
    expect(source).not.toMatch(/from ["']@\/lib\/domain\/knowledge\/retrieval["']/);
    expect(source).not.toMatch(/from ["']@\/lib\/ai\/search["']/);
  });

  it("never modifies gaps.ts, recommendations.ts, or evidence.ts business rules (imports only their public functions)", () => {
    const source = readFileSync(new URL("./copilotContext.ts", import.meta.url), "utf8");
    expect(source).toMatch(/from ["']@\/lib\/domain\/capability\/gaps["']/);
    expect(source).toMatch(/from ["']@\/lib\/domain\/capability\/recommendations["']/);
    expect(source).not.toMatch(/from ["']@\/lib\/domain\/capability\/evidence["']/);
  });
});
