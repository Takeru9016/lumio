import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Unit test for buildOrganizationCopilotContext — mirrors
 * instructorCopilotContext.test.ts's approach: mock the already-audited
 * getOrganizationCapabilityReport() (Phase 9) and prove only this
 * function's own responsibilities (call count, learnerId filtering,
 * aggregation, bounding).
 */
vi.mock("@/lib/domain/capability/organizationReport", () => ({
  getOrganizationCapabilityReport: vi.fn(),
}));

const { getOrganizationCapabilityReport } = await import(
  "@/lib/domain/capability/organizationReport"
);
const { buildOrganizationCopilotContext, OrganizationCopilotLearnerNotFoundError } = await import(
  "@/lib/domain/capability/organizationCopilotContext"
);

const getReportMock = vi.mocked(getOrganizationCapabilityReport);

const ctx = { userId: "admin-1", clerkId: "c1", tenantId: "t1", role: "ORG_ADMIN" as const };

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
      ],
    },
    {
      userId: "u2",
      name: "Cid",
      roleId: "r2",
      roleName: "Support",
      skills: [
        {
          skillId: "s3",
          skillName: "Troubleshooting",
          required: "BEGINNER",
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

describe("buildOrganizationCopilotContext", () => {
  it("calls getOrganizationCapabilityReport exactly once, with ctx.tenantId only", async () => {
    getReportMock.mockResolvedValue(PAGE as never);

    await buildOrganizationCopilotContext(ctx);

    expect(getReportMock).toHaveBeenCalledTimes(1);
    expect(getReportMock).toHaveBeenCalledWith("t1");
  });

  it("builds a cohort summary spanning multiple roles when no learnerId is given", async () => {
    getReportMock.mockResolvedValue(PAGE as never);

    const result = await buildOrganizationCopilotContext(ctx);

    expect(result.scope).toBe("cohort");
    expect(result.cohortSize).toBe(2);
    expect(result.roleBreakdown).toEqual(
      expect.arrayContaining([
        { roleName: "Sales Rep", learnerCount: 1 },
        { roleName: "Support", learnerCount: 1 },
      ])
    );
    expect(result.learner).toBeUndefined();
  });

  it("sets cohortTruncated true when the report page has a nextCursor", async () => {
    getReportMock.mockResolvedValue({ ...PAGE, nextCursor: "opaque-cursor" } as never);

    const result = await buildOrganizationCopilotContext(ctx);

    expect(result.cohortTruncated).toBe(true);
  });

  it("returns a learner-scoped context when learnerId matches a row in the authorized page", async () => {
    getReportMock.mockResolvedValue(PAGE as never);

    const result = await buildOrganizationCopilotContext(ctx, { learnerId: "u2" });

    expect(result.scope).toBe("learner");
    expect(result.learner).toEqual({
      learnerName: "Cid",
      roleName: "Support",
      skills: [
        { skillName: "Troubleshooting", required: "BEGINNER", current: "ADVANCED", met: true },
      ],
    });
  });

  it("throws OrganizationCopilotLearnerNotFoundError when learnerId is not in the authorized page — never queries the database directly", async () => {
    getReportMock.mockResolvedValue(PAGE as never);

    await expect(
      buildOrganizationCopilotContext(ctx, { learnerId: "someone-in-another-tenant" })
    ).rejects.toThrow(OrganizationCopilotLearnerNotFoundError);
    expect(getReportMock).toHaveBeenCalledTimes(1);
  });

  it("never exposes internal ids (userId/skillId/roleId) in the returned context", async () => {
    getReportMock.mockResolvedValue(PAGE as never);

    const cohort = await buildOrganizationCopilotContext(ctx);
    const learner = await buildOrganizationCopilotContext(ctx, { learnerId: "u2" });

    expect(JSON.stringify(cohort)).not.toMatch(/"u1"|"u2"|"s1"|"s3"|"r1"|"r2"/);
    expect(JSON.stringify(learner)).not.toMatch(/"u1"|"u2"|"s1"|"s3"|"r1"|"r2"/);
  });

  it("never imports the database, SkillEvidence, getRecommendedLearning, or Knowledge/Search infrastructure", () => {
    const source = readFileSync(
      new URL("./organizationCopilotContext.ts", import.meta.url),
      "utf8"
    );
    expect(source).not.toMatch(/from ["']@\/lib\/db["']/);
    expect(source).not.toMatch(/from ["']@\/lib\/domain\/capability\/evidence["']/);
    expect(source).not.toMatch(/from ["']@\/lib\/domain\/capability\/recommendations["']/);
    expect(source).not.toMatch(/from ["']@\/lib\/ai\/runtime\/context["']/);
    expect(source).not.toMatch(/from ["']@\/lib\/domain\/knowledge\/retrieval["']/);
    expect(source).not.toMatch(/from ["']@\/lib\/domain\/capability\/instructorReport["']/);
  });
});
