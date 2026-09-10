import type {
  JobRole,
  RoleSkill,
  Skill,
  SkillCategory,
  SkillEvidence,
  UserJobRole,
  UserSkill,
} from "@/generated/prisma/client";

/**
 * Type-only foundation for the capability domain (Skill/Role/Evidence — see
 * docs/V2_DOMAIN_MODEL.md, "Capability"). No service layer yet: Phase 1 is
 * schema + auth foundation only (docs/V2_MIGRATION_MAP.md).
 */
export type { Skill, SkillCategory, JobRole, RoleSkill, UserJobRole, UserSkill, SkillEvidence };

export type UserSkillWithSkill = UserSkill & { skill: Skill };
export type RoleSkillWithSkill = RoleSkill & { skill: Skill };
