import { Prisma, type SkillProficiency } from "@/generated/prisma/client";
import type { AuthContext } from "@/lib/auth/context";
import { db } from "@/lib/db";
import { generateUniqueJobRoleSlug, generateUniqueSkillSlug } from "@/lib/slug";

type Ctx = AuthContext & { tenantId: string };

export class RoleManagementError extends Error {
  constructor(
    public status: 400 | 404 | 409,
    message: string
  ) {
    super(message);
    this.name = "RoleManagementError";
  }
}

function validateName(name: unknown): string {
  if (typeof name !== "string") throw new RoleManagementError(400, "Name is required");
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 100) {
    throw new RoleManagementError(400, "Name must be between 1 and 100 characters");
  }
  return trimmed;
}

function validateDescription(description: unknown): string | null {
  if (description === undefined || description === null) return null;
  if (typeof description !== "string") throw new RoleManagementError(400, "Invalid description");
  const trimmed = description.trim();
  if (trimmed.length > 1000) {
    throw new RoleManagementError(400, "Description must be 1000 characters or fewer");
  }
  return trimmed.length === 0 ? null : trimmed;
}

const REQUIRED_PROFICIENCIES: SkillProficiency[] = [
  "BEGINNER",
  "INTERMEDIATE",
  "ADVANCED",
  "EXPERT",
];

function validateRequiredProficiency(value: unknown): SkillProficiency {
  if (typeof value !== "string" || !REQUIRED_PROFICIENCIES.includes(value as SkillProficiency)) {
    throw new RoleManagementError(
      400,
      "requiredProficiency must be one of BEGINNER, INTERMEDIATE, ADVANCED, EXPERT"
    );
  }
  return value as SkillProficiency;
}

// ============================================================
// JobRole
// ============================================================

export async function listJobRoles(ctx: Ctx) {
  const roles = await db.jobRole.findMany({
    where: { tenantId: ctx.tenantId },
    select: {
      id: true,
      name: true,
      description: true,
      createdAt: true,
      _count: {
        select: {
          roleSkills: true,
          userJobRoles: { where: { user: { deletedAt: null } } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return roles.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    createdAt: r.createdAt,
    skillCount: r._count.roleSkills,
    assignedUserCount: r._count.userJobRoles,
  }));
}

export async function getJobRoleDetail(ctx: Ctx, roleId: string) {
  const role = await db.jobRole.findFirst({
    where: { id: roleId, tenantId: ctx.tenantId },
    select: {
      id: true,
      name: true,
      description: true,
      createdAt: true,
      roleSkills: {
        select: {
          skillId: true,
          requiredProficiency: true,
          skill: { select: { name: true } },
        },
      },
      userJobRoles: {
        where: { user: { deletedAt: null } },
        select: {
          isPrimary: true,
          assignedAt: true,
          user: { select: { id: true, name: true, email: true } },
        },
        orderBy: { assignedAt: "asc" },
      },
    },
  });
  if (!role) throw new RoleManagementError(404, "Role not found");

  return {
    id: role.id,
    name: role.name,
    description: role.description,
    createdAt: role.createdAt,
    roleSkills: role.roleSkills.map((rs) => ({
      skillId: rs.skillId,
      skillName: rs.skill.name,
      requiredProficiency: rs.requiredProficiency,
    })),
    assignedUsers: role.userJobRoles.map((ujr) => ({
      userId: ujr.user.id,
      name: ujr.user.name,
      email: ujr.user.email,
      isPrimary: ujr.isPrimary,
      assignedAt: ujr.assignedAt,
    })),
  };
}

async function assertNoDuplicateRoleName(
  ctx: Ctx,
  name: string,
  excludeRoleId?: string
): Promise<void> {
  const existing = await db.jobRole.findFirst({
    where: {
      tenantId: ctx.tenantId,
      id: excludeRoleId ? { not: excludeRoleId } : undefined,
      name: { equals: name, mode: "insensitive" },
    },
    select: { id: true },
  });
  if (existing) throw new RoleManagementError(409, "A role with this name already exists");
}

export async function createJobRole(ctx: Ctx, input: { name: unknown; description?: unknown }) {
  const name = validateName(input.name);
  const description = validateDescription(input.description);

  await assertNoDuplicateRoleName(ctx, name);
  const slug = await generateUniqueJobRoleSlug(name, ctx.tenantId);

  return db.jobRole.create({
    data: { tenantId: ctx.tenantId, name, description, slug },
    select: { id: true, name: true, description: true, createdAt: true },
  });
}

export async function updateJobRole(
  ctx: Ctx,
  roleId: string,
  input: { name?: unknown; description?: unknown }
) {
  const existing = await db.jobRole.findFirst({ where: { id: roleId, tenantId: ctx.tenantId } });
  if (!existing) throw new RoleManagementError(404, "Role not found");

  const name = input.name === undefined ? existing.name : validateName(input.name);
  const description =
    input.description === undefined ? existing.description : validateDescription(input.description);

  if (name !== existing.name) {
    await assertNoDuplicateRoleName(ctx, name, roleId);
  }

  return db.jobRole.update({
    where: { id: roleId },
    data: { name, description },
    select: { id: true, name: true, description: true, createdAt: true },
  });
}

export async function deleteJobRole(ctx: Ctx, roleId: string): Promise<void> {
  const role = await db.jobRole.findFirst({
    where: { id: roleId, tenantId: ctx.tenantId },
    select: {
      id: true,
      _count: { select: { userJobRoles: { where: { user: { deletedAt: null } } } } },
    },
  });
  if (!role) throw new RoleManagementError(404, "Role not found");

  if (role._count.userJobRoles > 0) {
    throw new RoleManagementError(409, "Remove all assigned users before deleting this role");
  }

  await db.jobRole.delete({ where: { id: roleId } });
}

// ============================================================
// Skill (minimal creation only — no category, no edit, no delete)
// ============================================================

export async function createSkillMinimal(
  ctx: Ctx,
  input: { name: unknown; description?: unknown }
) {
  const name = validateName(input.name);
  const description = validateDescription(input.description);

  const existing = await db.skill.findFirst({
    where: { tenantId: ctx.tenantId, name: { equals: name, mode: "insensitive" } },
    select: { id: true },
  });
  if (existing) throw new RoleManagementError(409, "A skill with this name already exists");

  const slug = await generateUniqueSkillSlug(name, ctx.tenantId);

  return db.skill.create({
    data: { tenantId: ctx.tenantId, name, description, slug, status: "ACTIVE", categoryId: null },
    select: { id: true, name: true, description: true },
  });
}

// ============================================================
// RoleSkill
// ============================================================

async function resolveTenantRole(ctx: Ctx, roleId: string) {
  const role = await db.jobRole.findFirst({ where: { id: roleId, tenantId: ctx.tenantId } });
  if (!role) throw new RoleManagementError(404, "Role not found");
  return role;
}

async function resolveTenantSkill(ctx: Ctx, skillId: string) {
  const skill = await db.skill.findFirst({ where: { id: skillId, tenantId: ctx.tenantId } });
  if (!skill) throw new RoleManagementError(404, "Skill not found");
  return skill;
}

export async function addRoleSkill(
  ctx: Ctx,
  roleId: string,
  input: { skillId: unknown; requiredProficiency: unknown }
) {
  await resolveTenantRole(ctx, roleId);
  if (typeof input.skillId !== "string" || input.skillId.length === 0) {
    throw new RoleManagementError(400, "skillId is required");
  }
  await resolveTenantSkill(ctx, input.skillId);
  const requiredProficiency = validateRequiredProficiency(input.requiredProficiency);

  try {
    return await db.roleSkill.create({
      data: { roleId, skillId: input.skillId, requiredProficiency, isRequired: true },
      select: { skillId: true, requiredProficiency: true, skill: { select: { name: true } } },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new RoleManagementError(409, "This skill is already required by this role");
    }
    throw err;
  }
}

export async function updateRoleSkill(
  ctx: Ctx,
  roleId: string,
  skillId: string,
  input: { requiredProficiency: unknown }
) {
  await resolveTenantRole(ctx, roleId);
  const requiredProficiency = validateRequiredProficiency(input.requiredProficiency);

  const existing = await db.roleSkill.findFirst({ where: { roleId, skillId } });
  if (!existing) throw new RoleManagementError(404, "This skill is not required by this role");

  return db.roleSkill.update({
    where: { roleId_skillId: { roleId, skillId } },
    data: { requiredProficiency },
    select: { skillId: true, requiredProficiency: true },
  });
}

export async function removeRoleSkill(ctx: Ctx, roleId: string, skillId: string): Promise<void> {
  await resolveTenantRole(ctx, roleId);
  const existing = await db.roleSkill.findFirst({ where: { roleId, skillId } });
  if (!existing) throw new RoleManagementError(404, "This skill is not required by this role");

  await db.roleSkill.delete({ where: { roleId_skillId: { roleId, skillId } } });
}

// ============================================================
// UserJobRole
// ============================================================

async function resolveTenantUser(ctx: Ctx, userId: string) {
  const user = await db.user.findFirst({
    where: { id: userId, tenantId: ctx.tenantId, deletedAt: null },
    select: { id: true },
  });
  if (!user) throw new RoleManagementError(404, "User not found");
  return user;
}

/**
 * Demotes every other UserJobRole for this user in this tenant, then
 * creates/updates the target assignment as primary — inside one
 * transaction. This is the only place `isPrimary: true` is ever written;
 * it does not by itself guarantee at-most-one-primary under concurrent
 * requests (Postgres read-committed lets two concurrent calls each demote
 * the rows they see, then each insert a new primary row the other never
 * saw). `resolvePrimaryRoleId` in gaps.ts already tolerates that residual
 * case deterministically (earliest `assignedAt` wins) — this function
 * narrows the window without depending on a schema change to close it.
 */
async function promoteToPrimary(ctx: Ctx, userId: string, roleId: string) {
  return db.$transaction(async (tx) => {
    await tx.userJobRole.updateMany({
      where: { tenantId: ctx.tenantId, userId, isPrimary: true, roleId: { not: roleId } },
      data: { isPrimary: false },
    });

    return tx.userJobRole.upsert({
      where: { userId_roleId: { userId, roleId } },
      create: { tenantId: ctx.tenantId, userId, roleId, isPrimary: true },
      update: { isPrimary: true },
      select: { userId: true, roleId: true, isPrimary: true, assignedAt: true },
    });
  });
}

export async function assignUserJobRole(
  ctx: Ctx,
  roleId: string,
  input: { userId: unknown; isPrimary?: unknown }
) {
  await resolveTenantRole(ctx, roleId);
  if (typeof input.userId !== "string" || input.userId.length === 0) {
    throw new RoleManagementError(400, "userId is required");
  }
  await resolveTenantUser(ctx, input.userId);

  // Duplicate-assignment check runs before either branch — promoteToPrimary
  // upserts, so without this an already-assigned role re-POSTed with
  // isPrimary:true would silently flip to primary instead of 409ing (a
  // duplicate must never be a silent no-op, and promotion of an *existing*
  // assignment is PATCH's job, not POST's).
  const existing = await db.userJobRole.findFirst({
    where: { tenantId: ctx.tenantId, userId: input.userId, roleId },
    select: { id: true },
  });
  if (existing) {
    throw new RoleManagementError(409, "This user already has this role assigned");
  }

  const requestedPrimary = input.isPrimary === true;

  if (requestedPrimary) {
    return promoteToPrimary(ctx, input.userId, roleId);
  }

  // First assignment always becomes primary (no other role exists yet to
  // conflict with) — a subsequent, non-primary-requested assignment defaults
  // to false, since the schema's own `@default(true)` cannot be relied on
  // here to express that rule.
  const hasExistingRole = await db.userJobRole.findFirst({
    where: { tenantId: ctx.tenantId, userId: input.userId },
    select: { id: true },
  });
  const isPrimary = !hasExistingRole;

  try {
    return await db.userJobRole.create({
      data: { tenantId: ctx.tenantId, userId: input.userId, roleId, isPrimary },
      select: { userId: true, roleId: true, isPrimary: true, assignedAt: true },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new RoleManagementError(409, "This user already has this role assigned");
    }
    throw err;
  }
}

export async function changePrimaryUserJobRole(ctx: Ctx, roleId: string, userId: string) {
  await resolveTenantRole(ctx, roleId);
  await resolveTenantUser(ctx, userId);

  const existing = await db.userJobRole.findFirst({
    where: { tenantId: ctx.tenantId, userId, roleId },
  });
  if (!existing) throw new RoleManagementError(404, "This user does not have this role assigned");

  return promoteToPrimary(ctx, userId, roleId);
}

export async function removeUserJobRole(ctx: Ctx, roleId: string, userId: string): Promise<void> {
  await resolveTenantRole(ctx, roleId);

  const existing = await db.userJobRole.findFirst({
    where: { tenantId: ctx.tenantId, userId, roleId },
  });
  if (!existing) throw new RoleManagementError(404, "This user does not have this role assigned");

  // No automatic promotion of another role to primary — a user left with
  // zero primary roles is an explicitly supported state (computeCapabilityGap
  // returns `{ role: null, gaps: [] }` for it, never an error).
  await db.userJobRole.delete({ where: { userId_roleId: { userId, roleId } } });
}
