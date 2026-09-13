import type { AuthContext } from "@/lib/auth/context";
import { getOrganizationCapabilityReport } from "@/lib/domain/capability/organizationReport";

type Ctx = AuthContext & { tenantId: string };

export type StaffCopilotSkillAggregate = {
  skillName: string;
  metCount: number;
  gapCount: number;
};

export type StaffCopilotLearnerDetail = {
  learnerName: string;
  roleName: string;
  skills: Array<{
    skillName: string;
    required: string;
    current: string;
    met: boolean;
  }>;
};

export type StaffCopilotContext = {
  scope: "cohort" | "learner";
  cohortSize: number;
  cohortTruncated: boolean;
  roleBreakdown: Array<{ roleName: string; learnerCount: number }>;
  skillAggregates: StaffCopilotSkillAggregate[];
  learner?: StaffCopilotLearnerDetail;
};

export class OrganizationCopilotLearnerNotFoundError extends Error {
  constructor() {
    super("Learner not found in your capability report");
    this.name = "OrganizationCopilotLearnerNotFoundError";
  }
}

/**
 * Bounded, prompt-ready capability context for the Organization Capability
 * Copilot (Phase 13 locked contract). Calls getOrganizationCapabilityReport()
 * exactly once, scoped to `ctx.tenantId` only — that report's own tenant
 * filter is the entire authorization boundary (Phase 9, unchanged, not
 * re-derived here). This function performs no database access of its own —
 * it never imports `@/lib/db` — and never calls getRecommendedLearning or
 * touches SkillEvidence.
 *
 * `learnerId`, if supplied, is matched only against the in-memory array this
 * one authorized report call already returned — never a second database
 * lookup. A learner outside that authorized page (a different tenant's
 * user, or simply beyond the first page) throws
 * OrganizationCopilotLearnerNotFoundError, which the route maps to a
 * generic 404 — this function never confirms or denies a learner's
 * existence outside the caller's own tenant.
 *
 * Bounded to exactly one report page (the report's own default page size) —
 * no cursor-following, no multi-page traversal. `cohortTruncated` signals
 * when more learners exist beyond this page.
 *
 * Deliberately not shared with instructorCopilotContext.ts — the two
 * functions call different reports with different security boundaries
 * (course-ownership vs. tenant-wide), and keeping them separate keeps each
 * function's authorization boundary readable in isolation rather than
 * hidden behind a role branch inside one generic "staff context" function.
 */
export async function buildOrganizationCopilotContext(
  ctx: Ctx,
  options?: { learnerId?: string }
): Promise<StaffCopilotContext> {
  const page = await getOrganizationCapabilityReport(ctx.tenantId);
  const { learners, nextCursor } = page;
  const cohortTruncated = nextCursor !== null;

  if (options?.learnerId) {
    const match = learners.find((l) => l.userId === options.learnerId);
    if (!match) throw new OrganizationCopilotLearnerNotFoundError();

    return {
      scope: "learner",
      cohortSize: learners.length,
      cohortTruncated,
      roleBreakdown: [],
      skillAggregates: [],
      learner: {
        learnerName: match.name,
        roleName: match.roleName,
        skills: match.skills.map((s) => ({
          skillName: s.skillName,
          required: s.required,
          current: s.current,
          met: s.met,
        })),
      },
    };
  }

  const roleCounts = new Map<string, number>();
  const skillCounts = new Map<string, { met: number; gap: number }>();
  for (const learner of learners) {
    roleCounts.set(learner.roleName, (roleCounts.get(learner.roleName) ?? 0) + 1);
    for (const skill of learner.skills) {
      const entry = skillCounts.get(skill.skillName) ?? { met: 0, gap: 0 };
      if (skill.met) entry.met += 1;
      else entry.gap += 1;
      skillCounts.set(skill.skillName, entry);
    }
  }

  return {
    scope: "cohort",
    cohortSize: learners.length,
    cohortTruncated,
    roleBreakdown: [...roleCounts.entries()].map(([roleName, learnerCount]) => ({
      roleName,
      learnerCount,
    })),
    skillAggregates: [...skillCounts.entries()].map(([skillName, counts]) => ({
      skillName,
      metCount: counts.met,
      gapCount: counts.gap,
    })),
  };
}
