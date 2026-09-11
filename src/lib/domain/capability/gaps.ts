import type { SkillProficiency } from "@/generated/prisma/client";
import type { AuthContext } from "@/lib/auth/context";
import { db } from "@/lib/db";
import { compareProficiency } from "@/lib/domain/capability/proficiencyOrder";

type Ctx = AuthContext & { tenantId: string };

export type RoleRequirement = {
  skillId: string;
  skillName: string;
  requiredProficiency: SkillProficiency;
};

/**
 * Required skills for a role — only `isRequired: true` rows, and only
 * skills that are still `SkillStatus.ACTIVE` (an archived skill is no
 * longer a live target, so it's excluded rather than reported as a gap).
 * `JobRole` has no archival/status field in the current schema — every
 * JobRole row is treated as active; not a schema addition this phase, a
 * documented limitation (Phase 5 architecture challenge, Challenge 13).
 */
export async function getRoleRequirements(ctx: Ctx, roleId: string): Promise<RoleRequirement[]> {
  const role = await db.jobRole.findFirst({ where: { id: roleId, tenantId: ctx.tenantId } });
  if (!role) return [];

  const roleSkills = await db.roleSkill.findMany({
    where: { roleId, isRequired: true, skill: { status: "ACTIVE" } },
    select: { requiredProficiency: true, skill: { select: { id: true, name: true } } },
  });

  return roleSkills.map((rs) => ({
    skillId: rs.skill.id,
    skillName: rs.skill.name,
    requiredProficiency: rs.requiredProficiency,
  }));
}

export type UserSkillState = {
  skillId: string;
  skillName: string;
  proficiency: SkillProficiency;
  lastAssessedAt: Date | null;
};

/** The current user's own demonstrated/assigned skill state — self-read only, per `ctx`. */
export async function getUserSkillState(ctx: Ctx): Promise<UserSkillState[]> {
  const rows = await db.userSkill.findMany({
    where: { tenantId: ctx.tenantId, userId: ctx.userId },
    select: {
      skillId: true,
      proficiency: true,
      lastAssessedAt: true,
      skill: { select: { name: true } },
    },
  });
  return rows.map((r) => ({
    skillId: r.skillId,
    skillName: r.skill.name,
    proficiency: r.proficiency,
    lastAssessedAt: r.lastAssessedAt,
  }));
}

/**
 * Deterministically resolves a user's primary JobRole. `UserJobRole` has no
 * constraint preventing more than one `isPrimary: true` row per user (only
 * `[userId, roleId]` is unique) — if that data inconsistency exists, the
 * row with the earliest `assignedAt` wins, and the condition is logged
 * rather than resolved via an unordered `findFirst` (Challenge 13).
 */
async function resolvePrimaryRoleId(ctx: Ctx): Promise<string | null> {
  const primaryRows = await db.userJobRole.findMany({
    where: { tenantId: ctx.tenantId, userId: ctx.userId, isPrimary: true },
    select: { roleId: true, assignedAt: true },
    orderBy: { assignedAt: "asc" },
  });

  if (primaryRows.length === 0) return null;
  if (primaryRows.length > 1) {
    console.warn(
      `[capability] Data integrity: user ${ctx.userId} (tenant ${ctx.tenantId}) has ${primaryRows.length} primary UserJobRole rows — using the earliest assignedAt`
    );
  }
  return primaryRows[0].roleId;
}

export type CapabilityGapItem = RoleRequirement & {
  currentProficiency: SkillProficiency;
  met: boolean;
};

export type CapabilityGapResult = {
  role: { id: string; name: string } | null;
  gaps: CapabilityGapItem[];
};

/**
 * Dynamic gap calculation — Required (RoleSkill.requiredProficiency) vs.
 * Current (UserSkill.proficiency, or NONE if no UserSkill row exists yet).
 * No SkillGap table, no persistence — recomputed on every call, exactly as
 * locked (Challenge 13/§K, and docs/V2_MIGRATION_MAP.md's Phase 1 note that
 * this was always meant to be computable rather than stored).
 *
 * With no `roleId` argument, resolves the caller's own primary role
 * (§ resolvePrimaryRoleId). A user with no primary role returns an empty
 * result (`role: null, gaps: []`), never an error.
 */
export async function computeCapabilityGap(
  ctx: Ctx,
  roleId?: string
): Promise<CapabilityGapResult> {
  const resolvedRoleId = roleId ?? (await resolvePrimaryRoleId(ctx));
  if (!resolvedRoleId) return { role: null, gaps: [] };

  const role = await db.jobRole.findFirst({
    where: { id: resolvedRoleId, tenantId: ctx.tenantId },
    select: { id: true, name: true },
  });
  if (!role) return { role: null, gaps: [] };

  const [requirements, userSkills] = await Promise.all([
    getRoleRequirements(ctx, resolvedRoleId),
    getUserSkillState(ctx),
  ]);

  const currentBySkill = new Map(userSkills.map((s) => [s.skillId, s.proficiency]));

  const gaps: CapabilityGapItem[] = requirements.map((req) => {
    const current: SkillProficiency = currentBySkill.get(req.skillId) ?? "NONE";
    return {
      ...req,
      currentProficiency: current,
      met: compareProficiency(req.requiredProficiency, current) <= 0,
    };
  });

  return { role, gaps };
}
