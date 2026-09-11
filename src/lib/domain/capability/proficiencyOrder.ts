import type { SkillProficiency } from "@/generated/prisma/client";

/**
 * The one explicit ordering used across the capability domain. Deliberately
 * hand-written, not derived from Prisma enum reflection or database enum
 * declaration order — neither is guaranteed to reflect intended rank (see
 * Phase 5 architecture challenge, "Proficiency ordering").
 */
export const PROFICIENCY_ORDER: SkillProficiency[] = [
  "NONE",
  "BEGINNER",
  "INTERMEDIATE",
  "ADVANCED",
  "EXPERT",
];

function rank(proficiency: SkillProficiency): number {
  return PROFICIENCY_ORDER.indexOf(proficiency);
}

/** -1 if a < b, 0 if equal, 1 if a > b. */
export function compareProficiency(a: SkillProficiency, b: SkillProficiency): -1 | 0 | 1 {
  const diff = rank(a) - rank(b);
  if (diff < 0) return -1;
  if (diff > 0) return 1;
  return 0;
}

export function isAtLeast(a: SkillProficiency, threshold: SkillProficiency): boolean {
  return rank(a) >= rank(threshold);
}

/** Order-independent by construction — safe to fold over any evidence set in any order. */
export function maxProficiency(values: SkillProficiency[]): SkillProficiency {
  return values.reduce<SkillProficiency>(
    (max, value) => (compareProficiency(value, max) > 0 ? value : max),
    "NONE"
  );
}
