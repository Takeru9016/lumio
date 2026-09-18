import type { AuthContext } from "@/lib/auth/context";
import {
  getInstructorCapabilityForLearnerRole,
  getInstructorCapabilityReport,
} from "@/lib/domain/capability/instructorReport";

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

export class InstructorCopilotLearnerNotFoundError extends Error {
  constructor() {
    super("Learner not found in your capability report");
    this.name = "InstructorCopilotLearnerNotFoundError";
  }
}

/**
 * Bounded, prompt-ready capability context for the Instructor Capability
 * Copilot (Phase 13 locked contract). Calls getInstructorCapabilityReport()
 * exactly once — that report's own Prisma `where` clause is the entire
 * authorization boundary (Course.instructorId === ctx.userId AND
 * Course.tenantId === ctx.tenantId, Phase 11, unchanged, not re-derived
 * here). This function performs no database access of its own — it cannot,
 * since it never imports `@/lib/db` — and never calls getRecommendedLearning
 * or touches SkillEvidence.
 *
 * `learnerId`, if supplied, is matched only against the in-memory array this
 * one authorized report call already returned — never a second database
 * lookup. A learner outside that authorized page (a different instructor's
 * student, a different tenant's user, or simply beyond the first page)
 * throws InstructorCopilotLearnerNotFoundError, which the route maps to a
 * generic 404 — this function never confirms or denies a learner's
 * existence outside the caller's own authorized population.
 *
 * Bounded to exactly one report page (the report's own default page size) —
 * no cursor-following, no multi-page traversal. `cohortTruncated` signals
 * when more learners exist beyond this page, so the prompt (and the model's
 * answer) can disclose that honestly rather than silently treating the
 * first page as the whole population.
 *
 * Phase 21: `options.roleId`, only meaningful alongside `learnerId`, scopes
 * the learner detail to one explicit role instead of the batch page's
 * primary-role-only row. This moves authorization for that path OUT of "the
 * report's own where-clause" and into getInstructorCapabilityForLearnerRole
 * itself, which re-validates both that this instructor owns the learner AND
 * that the learner actually holds `roleId` — the batch page's in-memory
 * match (still used when `roleId` is omitted) never carries non-primary
 * role data to match against.
 */
export async function buildInstructorCopilotContext(
  ctx: Ctx,
  options?: { learnerId?: string; roleId?: string }
): Promise<StaffCopilotContext> {
  const page = await getInstructorCapabilityReport(ctx.userId, ctx.tenantId);
  const { learners, nextCursor } = page;
  const cohortTruncated = nextCursor !== null;

  if (options?.learnerId && options?.roleId) {
    const match = await getInstructorCapabilityForLearnerRole(
      ctx.userId,
      ctx.tenantId,
      options.learnerId,
      options.roleId
    );
    if (!match) throw new InstructorCopilotLearnerNotFoundError();

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

  if (options?.learnerId) {
    const match = learners.find((l) => l.userId === options.learnerId);
    if (!match) throw new InstructorCopilotLearnerNotFoundError();

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
