import { db } from "@/lib/db";

export type SkillListItem = {
  id: string;
  name: string;
  categoryId: string | null;
  categoryName: string | null;
};

const MAX_RESULTS = 200;

/** Tenant-scoped, ACTIVE-only Skill list for picker UIs (Course Creator, Phase 8). */
export async function listActiveSkills(ctx: { tenantId: string }): Promise<SkillListItem[]> {
  const skills = await db.skill.findMany({
    where: { tenantId: ctx.tenantId, status: "ACTIVE" },
    select: { id: true, name: true, categoryId: true, category: { select: { name: true } } },
    orderBy: { name: "asc" },
    take: MAX_RESULTS,
  });

  return skills.map((s) => ({
    id: s.id,
    name: s.name,
    categoryId: s.categoryId,
    categoryName: s.category?.name ?? null,
  }));
}
