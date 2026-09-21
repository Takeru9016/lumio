import type { PathCourseChoice } from "@/lib/admin-path-client";
import type { AuthContext } from "@/lib/auth/context";
import { db } from "@/lib/db";
import { assertPathManager } from "@/lib/domain/learning-path/inputRules";

/** More than an administrator can usefully scroll; the picker also searches within these. */
export const PATH_COURSE_CHOICES_LIMIT = 500;

/**
 * The courses an organisation administrator can choose from when adding to a path:
 * the organisation's own courses that are not archived, by title. There is no API
 * that lists these (the path API only takes a course id), so the editor's page
 * reads them here, for the session's own tenant and for an ORG_ADMIN only.
 *
 * This is a list to choose from, not a rule about what may be added: whether a
 * course can join a path is decided by the add endpoint alone, and it can still
 * refuse one of these (a draft to a published path, for instance).
 */
export async function listPathCourseChoices(ctx: AuthContext): Promise<PathCourseChoice[]> {
  const actor = assertPathManager(ctx);
  const courses = await db.course.findMany({
    where: { tenantId: actor.tenantId, status: { not: "ARCHIVED" } },
    select: { id: true, title: true, slug: true, status: true },
    orderBy: [{ title: "asc" }, { id: "asc" }],
    take: PATH_COURSE_CHOICES_LIMIT,
  });
  return courses;
}
