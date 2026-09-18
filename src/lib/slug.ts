import { db } from "@/lib/db";

export function slugify(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/**
 * Generates a slug for a new course, appending -2, -3, ... on collision.
 */
export async function generateUniqueCourseSlug(title: string): Promise<string> {
  const base = slugify(title) || "course";

  let slug = base;
  let suffix = 2;
  while (await db.course.findUnique({ where: { slug }, select: { id: true } })) {
    slug = `${base}-${suffix}`;
    suffix += 1;
  }

  return slug;
}

/**
 * Generates a slug for a new lesson, unique across the whole course (not just
 * its section) — the URL is /courses/{course}/lessons/{lesson}, so a lesson
 * slug must not collide with any other lesson's slug anywhere in the course.
 */
export async function generateUniqueLessonSlug(title: string, courseId: string): Promise<string> {
  const base = slugify(title) || "lesson";

  let slug = base;
  let suffix = 2;
  while (
    await db.lesson.findFirst({
      where: { slug, section: { courseId } },
      select: { id: true },
    })
  ) {
    slug = `${base}-${suffix}`;
    suffix += 1;
  }

  return slug;
}

/** Generates a JobRole slug unique within the given tenant (JobRole.slug is [tenantId, slug]-unique). */
export async function generateUniqueJobRoleSlug(title: string, tenantId: string): Promise<string> {
  const base = slugify(title) || "role";

  let slug = base;
  let suffix = 2;
  while (await db.jobRole.findUnique({ where: { tenantId_slug: { tenantId, slug } } })) {
    slug = `${base}-${suffix}`;
    suffix += 1;
  }

  return slug;
}

/** Generates a Skill slug unique within the given tenant (Skill.slug is [tenantId, slug]-unique). */
export async function generateUniqueSkillSlug(title: string, tenantId: string): Promise<string> {
  const base = slugify(title) || "skill";

  let slug = base;
  let suffix = 2;
  while (await db.skill.findUnique({ where: { tenantId_slug: { tenantId, slug } } })) {
    slug = `${base}-${suffix}`;
    suffix += 1;
  }

  return slug;
}
