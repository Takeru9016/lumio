import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Unit test for buildInstructorCopilotContext — a thin composition layer
 * over getInstructorCapabilityReport(), which already has its own real-DB,
 * ownership-boundary-audited test suite (Phase 11). Mocking that report
 * here isolates what this function itself is responsible for: calling it
 * exactly once, in-memory learnerId filtering, cohort aggregation, and
 * bounding — not re-proving the ownership boundary, which lives entirely
 * inside the mocked function.
 */
vi.mock("@/lib/domain/capability/instructorReport", () => ({
  getInstructorCapabilityReport: vi.fn(),
  getInstructorCapabilityForLearnerRole: vi.fn(),
}));

const { getInstructorCapabilityReport, getInstructorCapabilityForLearnerRole } = await import(
  "@/lib/domain/capability/instructorReport"
);
const { buildInstructorCopilotContext, InstructorCopilotLearnerNotFoundError } = await import(
  "@/lib/domain/capability/instructorCopilotContext"
);

const getReportMock = vi.mocked(getInstructorCapabilityReport);
const getForRoleMock = vi.mocked(getInstructorCapabilityForLearnerRole);

const ctx = { userId: "instructor-1", clerkId: "c1", tenantId: "t1", role: "INSTRUCTOR" as const };

const PAGE = {
  learners: [
    {
      userId: "u1",
      name: "Amy",
      roleId: "r1",
      roleName: "Sales Rep",
      skills: [
        {
          skillId: "s1",
          skillName: "Negotiation",
          required: "INTERMEDIATE",
          current: "BEGINNER",
          met: false,
        },
        {
          skillId: "s2",
          skillName: "Prospecting",
          required: "BEGINNER",
          current: "BEGINNER",
          met: true,
        },
      ],
    },
    {
      userId: "u2",
      name: "Bob",
      roleId: "r1",
      roleName: "Sales Rep",
      skills: [
        {
          skillId: "s1",
          skillName: "Negotiation",
          required: "INTERMEDIATE",
          current: "ADVANCED",
          met: true,
        },
      ],
    },
  ],
  nextCursor: null,
};

afterEach(() => {
  vi.resetAllMocks();
});

describe("buildInstructorCopilotContext", () => {
  it("calls getInstructorCapabilityReport exactly once, with ctx.userId and ctx.tenantId", async () => {
    getReportMock.mockResolvedValue(PAGE as never);

    await buildInstructorCopilotContext(ctx);

    expect(getReportMock).toHaveBeenCalledTimes(1);
    expect(getReportMock).toHaveBeenCalledWith("instructor-1", "t1");
  });

  it("builds a cohort summary (scope, size, role breakdown, skill aggregates) when no learnerId is given", async () => {
    getReportMock.mockResolvedValue(PAGE as never);

    const result = await buildInstructorCopilotContext(ctx);

    expect(result.scope).toBe("cohort");
    expect(result.cohortSize).toBe(2);
    expect(result.cohortTruncated).toBe(false);
    expect(result.roleBreakdown).toEqual([{ roleName: "Sales Rep", learnerCount: 2 }]);
    expect(result.skillAggregates).toEqual(
      expect.arrayContaining([
        { skillName: "Negotiation", metCount: 1, gapCount: 1 },
        { skillName: "Prospecting", metCount: 1, gapCount: 0 },
      ])
    );
    expect(result.learner).toBeUndefined();
  });

  it("sets cohortTruncated true when the report page has a nextCursor", async () => {
    getReportMock.mockResolvedValue({ ...PAGE, nextCursor: "opaque-cursor" } as never);

    const result = await buildInstructorCopilotContext(ctx);

    expect(result.cohortTruncated).toBe(true);
  });

  it("returns a learner-scoped context when learnerId matches a row in the authorized page", async () => {
    getReportMock.mockResolvedValue(PAGE as never);

    const result = await buildInstructorCopilotContext(ctx, { learnerId: "u1" });

    expect(result.scope).toBe("learner");
    expect(result.learner).toEqual({
      learnerName: "Amy",
      roleName: "Sales Rep",
      skills: [
        { skillName: "Negotiation", required: "INTERMEDIATE", current: "BEGINNER", met: false },
        { skillName: "Prospecting", required: "BEGINNER", current: "BEGINNER", met: true },
      ],
    });
  });

  it("throws InstructorCopilotLearnerNotFoundError when learnerId is not in the authorized page — never queries the database directly", async () => {
    getReportMock.mockResolvedValue(PAGE as never);

    await expect(
      buildInstructorCopilotContext(ctx, { learnerId: "someone-elses-student" })
    ).rejects.toThrow(InstructorCopilotLearnerNotFoundError);
    // Only the one report call happened — no second lookup was attempted.
    expect(getReportMock).toHaveBeenCalledTimes(1);
  });

  it("never exposes internal ids (userId/skillId/roleId) in the returned context", async () => {
    getReportMock.mockResolvedValue(PAGE as never);

    const cohort = await buildInstructorCopilotContext(ctx);
    const learner = await buildInstructorCopilotContext(ctx, { learnerId: "u1" });

    expect(JSON.stringify(cohort)).not.toMatch(/"u1"|"u2"|"s1"|"s2"|"r1"/);
    expect(JSON.stringify(learner)).not.toMatch(/"u1"|"u2"|"s1"|"s2"|"r1"/);
  });

  it("Phase 21: learnerId + roleId together delegate to getInstructorCapabilityForLearnerRole, not the batch page match", async () => {
    getReportMock.mockResolvedValue(PAGE as never);
    getForRoleMock.mockResolvedValue({
      userId: "u1",
      name: "Amy",
      roleId: "r2",
      roleName: "Team Lead",
      hasMultipleRoles: true,
      skills: [
        {
          skillId: "s3",
          skillName: "Leadership",
          required: "ADVANCED",
          current: "NONE",
          met: false,
        },
      ],
    });

    const result = await buildInstructorCopilotContext(ctx, { learnerId: "u1", roleId: "r2" });

    expect(getForRoleMock).toHaveBeenCalledWith("instructor-1", "t1", "u1", "r2");
    expect(result.scope).toBe("learner");
    expect(result.learner).toEqual({
      learnerName: "Amy",
      roleName: "Team Lead",
      skills: [{ skillName: "Leadership", required: "ADVANCED", current: "NONE", met: false }],
    });
  });

  it("Phase 21: roleId alone (no learnerId) is ignored — still resolves the cohort view, never calls getInstructorCapabilityForLearnerRole", async () => {
    getReportMock.mockResolvedValue(PAGE as never);

    const result = await buildInstructorCopilotContext(ctx, { roleId: "r2" });

    expect(getForRoleMock).not.toHaveBeenCalled();
    expect(result.scope).toBe("cohort");
  });

  it("Phase 21: learnerId alone (no roleId) still matches from the batch page, unchanged from pre-Phase-21 behavior", async () => {
    getReportMock.mockResolvedValue(PAGE as never);

    const result = await buildInstructorCopilotContext(ctx, { learnerId: "u1" });

    expect(getForRoleMock).not.toHaveBeenCalled();
    expect(result.scope).toBe("learner");
    expect(result.learner?.learnerName).toBe("Amy");
  });

  it("Phase 21: getInstructorCapabilityForLearnerRole returning null -> InstructorCopilotLearnerNotFoundError, same as an unmatched batch learnerId", async () => {
    getReportMock.mockResolvedValue(PAGE as never);
    getForRoleMock.mockResolvedValue(null);

    await expect(
      buildInstructorCopilotContext(ctx, { learnerId: "u1", roleId: "role-not-held" })
    ).rejects.toThrow(InstructorCopilotLearnerNotFoundError);
  });

  it("never imports the database, SkillEvidence, getRecommendedLearning, or Knowledge/Search infrastructure", () => {
    // Regex on actual import syntax, not a plain substring — this file's own
    // doc comments legitimately name these in prose to explain why they're
    // absent (Phase 11/12 precedent for why a naive substring check
    // false-fails against such comments).
    const source = readFileSync(new URL("./instructorCopilotContext.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from ["']@\/lib\/db["']/);
    expect(source).not.toMatch(/from ["']@\/lib\/domain\/capability\/evidence["']/);
    expect(source).not.toMatch(/from ["']@\/lib\/domain\/capability\/recommendations["']/);
    expect(source).not.toMatch(/from ["']@\/lib\/ai\/runtime\/context["']/);
    expect(source).not.toMatch(/from ["']@\/lib\/domain\/knowledge\/retrieval["']/);
    expect(source).not.toMatch(/from ["']@\/lib\/domain\/capability\/organizationReport["']/);
  });
});
