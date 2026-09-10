import type { AuthContext } from "@/lib/auth/context";
import { requireTenant } from "@/lib/auth/context";
import { db } from "@/lib/db";
import { assertCanCreateCourse } from "@/lib/domain/course/authorization";
import { saveDraftInputSchema } from "@/lib/domain/course-creator/schema";
import { generateUniqueCourseSlug, slugify } from "@/lib/slug";

/**
 * Deduplicates lesson slugs within a single brand-new course without a DB
 * round trip per lesson — safe because the course this creates has no
 * existing lessons yet, so the only collision risk is two proposal lessons
 * sharing a title.
 */
function uniqueSlugWithin(title: string, used: Set<string>): string {
  const base = slugify(title) || "lesson";
  let slug = base;
  let suffix = 2;
  while (used.has(slug)) {
    slug = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(slug);
  return slug;
}

/**
 * The human/application save boundary for the AI Course Creator (spec §9).
 * This function is never called by, or on behalf of, the AI runtime — it is
 * invoked directly by save/route.ts from an authenticated human request, and
 * it never calls generateObject/streamText or any src/lib/ai/runtime/* export.
 *
 * The proposal is treated as fully untrusted input: `rawInput` is parsed
 * against saveDraftInputSchema (`.strict()` — tenantId/userId/creatorId/
 * courseId/publication-state fields aren't even accepted keys), instructor
 * role + plan limits are re-checked via the same assertCanCreateCourse
 * POST /api/courses uses, every targetSkillId is re-verified against the
 * database to belong to the caller's own tenant (a client-claimed skill id
 * from another tenant is silently dropped, never trusted), and the Course is
 * always created as DRAFT with instructorId/tenantId taken from `authCtx`
 * only — never from `rawInput`.
 */
export async function saveCourseDraft(authCtx: AuthContext, rawInput: unknown) {
  requireTenant(authCtx);
  const input = saveDraftInputSchema.parse(rawInput);

  await assertCanCreateCourse(authCtx.userId);

  let verifiedSkillIds: string[] = [];
  if (input.targetSkillIds.length > 0) {
    const skills = await db.skill.findMany({
      where: { id: { in: input.targetSkillIds }, tenantId: authCtx.tenantId },
      select: { id: true },
    });
    verifiedSkillIds = skills.map((s) => s.id);
  }

  const slug = await generateUniqueCourseSlug(input.title);
  const usedLessonSlugs = new Set<string>();

  return db.$transaction(async (tx) => {
    const course = await tx.course.create({
      data: {
        title: input.title,
        slug,
        description: input.description,
        thumbnailUrl: input.thumbnailUrl,
        category: input.category,
        level: input.level,
        price: 0,
        currency: "INR",
        instructorId: authCtx.userId,
        tenantId: authCtx.tenantId,
        status: "DRAFT",
      },
    });

    for (const [sectionIndex, section] of input.sections.entries()) {
      const createdSection = await tx.section.create({
        data: { title: section.title, order: sectionIndex, courseId: course.id },
      });

      for (const [lessonIndex, lesson] of section.lessons.entries()) {
        await tx.lesson.create({
          data: {
            title: lesson.title,
            slug: uniqueSlugWithin(lesson.title, usedLessonSlugs),
            description: lesson.objective,
            type: lesson.contentType,
            order: lessonIndex,
            isPublished: false,
            isFree: false,
            sectionId: createdSection.id,
          },
        });
      }
    }

    if (verifiedSkillIds.length > 0) {
      await tx.courseSkill.createMany({
        data: verifiedSkillIds.map((skillId) => ({ courseId: course.id, skillId })),
        skipDuplicates: true,
      });
    }

    return course;
  });
}
