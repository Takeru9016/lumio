import type { SkillProficiency } from "@/generated/prisma/client";
import type { AuthContext } from "@/lib/auth/context";
import { db } from "@/lib/db";
import { computeCapabilityGap } from "@/lib/domain/capability/gaps";
import { PROFICIENCY_ORDER } from "@/lib/domain/capability/proficiencyOrder";

type Ctx = AuthContext & { tenantId: string };

const MAX_RECOMMENDATIONS = 5;

export type RecommendationReasonSkill = {
  skillId: string;
  skillName: string;
  requiredProficiency: SkillProficiency;
  currentProficiency: SkillProficiency;
};

export type RecommendedCourse = {
  courseId: string;
  courseTitle: string;
  // Internal-only field — the locked public API shape omits this (see the
  // route). Carried here so the dashboard can build /courses/[slug] links
  // by calling this function directly, without a second per-course lookup.
  courseSlug: string;
  reasonSkills: RecommendationReasonSkill[];
};

export type RecommendedLearning = {
  recommendations: RecommendedCourse[];
};

/**
 * Ordinal distance on the existing PROFICIENCY_ORDER — the only
 * deterministic, field-derived severity measure (Phase 6 locked contract,
 * §E): how many proficiency levels short the learner is, not an invented
 * business weight.
 */
function severity(required: SkillProficiency, current: SkillProficiency): number {
  return PROFICIENCY_ORDER.indexOf(required) - PROFICIENCY_ORDER.indexOf(current);
}

type CourseAggregate = {
  courseId: string;
  courseTitle: string;
  courseSlug: string;
  createdAt: Date;
  reasonSkills: RecommendationReasonSkill[];
};

/**
 * Read-only, deterministic recommendation service (Phase 6 locked
 * contract). Reuses computeCapabilityGap unchanged for role/gap
 * resolution — never reimplements primary-role resolution or proficiency
 * comparison. Performs zero writes, no $transaction, no AI, no RAG.
 *
 * Query shape is exactly three DB round trips (locked §P):
 *   1. computeCapabilityGap(ctx) — gap resolution (2 queries internally)
 *   2. one CourseSkill.findMany, joined through Course + Skill for
 *      tenant/status/active filtering in a single query
 *   3. one Enrollment.findMany for the candidate course ids
 * Aggregation, ranking, and the top-5 cap all happen in memory afterward —
 * never a raw `take` before aggregation (that could discard a more severe
 * candidate whose CourseSkill row simply sorted later in the DB).
 */
export async function getRecommendedLearning(ctx: Ctx): Promise<RecommendedLearning> {
  const { gaps } = await computeCapabilityGap(ctx);
  const unmetGaps = gaps.filter((g) => !g.met);
  if (unmetGaps.length === 0) {
    return { recommendations: [] };
  }

  const gapBySkillId = new Map(unmetGaps.map((g) => [g.skillId, g]));

  // Tenant/status/active filtering happens inside the query itself (never
  // fetch-then-filter): Course.tenantId must equal ctx.tenantId exactly —
  // never null, never another tenant (Phase 6 locked contract, §B/§C,
  // corrects the earlier discovery-pass assumption that a null tenant might
  // be globally recommendable — the existing course catalog page never
  // treats it that way for a tenant-scoped learner, so neither does this).
  const mappings = await db.courseSkill.findMany({
    where: {
      skillId: { in: [...gapBySkillId.keys()] },
      skill: { status: "ACTIVE" },
      course: { status: "PUBLISHED", tenantId: ctx.tenantId },
    },
    select: {
      skillId: true,
      skill: { select: { id: true, name: true } },
      course: { select: { id: true, title: true, slug: true, createdAt: true } },
    },
  });

  if (mappings.length === 0) {
    return { recommendations: [] };
  }

  const candidateCourseIds = [...new Set(mappings.map((m) => m.course.id))];

  // REFUNDED deliberately does not exclude — access was revoked, so the
  // course is neither "in progress" nor "done" (Phase 6 locked contract, §D).
  const activeOrCompletedEnrollments = await db.enrollment.findMany({
    where: {
      userId: ctx.userId,
      courseId: { in: candidateCourseIds },
      status: { in: ["ACTIVE", "COMPLETED"] },
    },
    select: { courseId: true },
  });
  const excludedCourseIds = new Set(activeOrCompletedEnrollments.map((e) => e.courseId));

  const byCourse = new Map<string, CourseAggregate>();

  for (const mapping of mappings) {
    if (excludedCourseIds.has(mapping.course.id)) continue;
    const gap = gapBySkillId.get(mapping.skillId);
    if (!gap) continue;

    let entry = byCourse.get(mapping.course.id);
    if (!entry) {
      entry = {
        courseId: mapping.course.id,
        courseTitle: mapping.course.title,
        courseSlug: mapping.course.slug,
        createdAt: mapping.course.createdAt,
        reasonSkills: [],
      };
      byCourse.set(mapping.course.id, entry);
    }

    entry.reasonSkills.push({
      skillId: mapping.skill.id,
      skillName: mapping.skill.name,
      requiredProficiency: gap.requiredProficiency,
      currentProficiency: gap.currentProficiency,
    });
  }

  const ranked = [...byCourse.values()]
    .map((course) => {
      const reasonSkills = [...course.reasonSkills].sort(
        (a, b) =>
          severity(b.requiredProficiency, b.currentProficiency) -
          severity(a.requiredProficiency, a.currentProficiency)
      );
      const maxSeverity = severity(
        reasonSkills[0].requiredProficiency,
        reasonSkills[0].currentProficiency
      );
      return { ...course, reasonSkills, maxSeverity, skillCount: reasonSkills.length };
    })
    .sort((a, b) => {
      if (b.maxSeverity !== a.maxSeverity) return b.maxSeverity - a.maxSeverity;
      if (b.skillCount !== a.skillCount) return b.skillCount - a.skillCount;
      const createdAtDiff = a.createdAt.getTime() - b.createdAt.getTime();
      if (createdAtDiff !== 0) return createdAtDiff;
      return a.courseId < b.courseId ? -1 : a.courseId > b.courseId ? 1 : 0;
    })
    .slice(0, MAX_RECOMMENDATIONS)
    .map(({ courseId, courseTitle, courseSlug, reasonSkills }) => ({
      courseId,
      courseTitle,
      courseSlug,
      reasonSkills,
    }));

  return { recommendations: ranked };
}
