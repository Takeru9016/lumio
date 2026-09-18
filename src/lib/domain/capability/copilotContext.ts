import type { SkillProficiency } from "@/generated/prisma/client";
import type { AuthContext } from "@/lib/auth/context";
import { computeCapabilityGap, getUserSkillState } from "@/lib/domain/capability/gaps";
import { getRecommendedLearning } from "@/lib/domain/capability/recommendations";

type Ctx = AuthContext & { tenantId: string };

export type CopilotRequiredSkill = {
  skillName: string;
  requiredProficiency: SkillProficiency;
  currentProficiency: SkillProficiency;
  met: boolean;
};

export type CopilotRecommendedCourse = {
  courseTitle: string;
  reasonSkills: Array<{
    skillName: string;
    requiredProficiency: SkillProficiency;
    currentProficiency: SkillProficiency;
  }>;
};

export type CopilotCapabilityContext = {
  hasPrimaryRole: boolean;
  roleName: string | null;
  requiredSkills: CopilotRequiredSkill[];
  recommendedCourses: CopilotRecommendedCourse[];
};

/**
 * Bounded, prompt-ready capability context for the Capability Copilot
 * (Phase 12 locked contract). Reuses `computeCapabilityGap`/
 * `getUserSkillState`/`getRecommendedLearning` exactly as `/capability`'s own
 * page composition and the Phase 6 dashboard card already do — never
 * reimplements primary-role resolution, proficiency comparison, or
 * recommendation ranking. Self-scoped by `ctx` only; no caller-supplied
 * identity parameter exists.
 *
 * Deliberately excludes `SkillEvidence` entirely (never queried, never
 * imported here) and every internal id (skillId/courseId/roleId) — only
 * display-facing names/proficiencies/titles reach the model, per the locked
 * Phase 12 contract's "no raw Prisma rows, no unnecessary ids" requirement.
 *
 * Phase 21: `roleId` is an optional pass-through to computeCapabilityGap/
 * getRecommendedLearning — the caller (the /api/ai/copilot route) is
 * responsible for confirming the caller actually holds `roleId` before
 * passing it in here; this function does not re-validate it. `hasPrimaryRole`
 * keeps its Phase 12 name for minimal diff even though it's now true for any
 * resolved role (primary-default or an explicitly selected non-primary one)
 * — it means "a role was resolved," not literally "the resolved role is primary."
 */
export async function buildCopilotContext(
  ctx: Ctx,
  roleId?: string
): Promise<CopilotCapabilityContext> {
  const [gapResult, userSkills, recommended] = await Promise.all([
    computeCapabilityGap(ctx, roleId),
    getUserSkillState(ctx),
    getRecommendedLearning(ctx, roleId),
  ]);

  if (!gapResult.role) {
    return {
      hasPrimaryRole: false,
      roleName: null,
      requiredSkills: [],
      recommendedCourses: [],
    };
  }

  // getUserSkillState is the same source /capability's page reads current
  // proficiency alongside computeCapabilityGap from — used here rather than
  // trusting computeCapabilityGap's own internal current-proficiency field a
  // second, undocumented way. A skill with no UserSkill row falls back to
  // the gap result's own NONE default, identical to gaps.ts's own rule.
  const currentBySkillId = new Map(userSkills.map((s) => [s.skillId, s.proficiency]));

  const requiredSkills: CopilotRequiredSkill[] = gapResult.gaps.map((gap) => ({
    skillName: gap.skillName,
    requiredProficiency: gap.requiredProficiency,
    currentProficiency: currentBySkillId.get(gap.skillId) ?? gap.currentProficiency,
    met: gap.met,
  }));

  const recommendedCourses: CopilotRecommendedCourse[] = recommended.recommendations.map((r) => ({
    courseTitle: r.courseTitle,
    reasonSkills: r.reasonSkills.map((rs) => ({
      skillName: rs.skillName,
      requiredProficiency: rs.requiredProficiency,
      currentProficiency: rs.currentProficiency,
    })),
  }));

  return {
    hasPrimaryRole: true,
    roleName: gapResult.role.name,
    requiredSkills,
    recommendedCourses,
  };
}
