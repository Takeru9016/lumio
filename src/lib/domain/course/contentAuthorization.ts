import { db } from "@/lib/db";

export class ContentAuthorizationError extends Error {
  constructor(
    public status: 401 | 403 | 404,
    message: string
  ) {
    super(message);
    this.name = "ContentAuthorizationError";
  }
}

export type LessonChain = {
  lessonId: string;
  sectionId: string;
  courseId: string;
  instructorId: string;
  tenantId: string | null;
};

/**
 * Resolves lesson -> section -> course from the database, so a caller never
 * has to trust a client-supplied section/course id to establish which course
 * a lesson belongs to.
 */
export async function resolveLessonChain(lessonId: string): Promise<LessonChain | null> {
  const lesson = await db.lesson.findUnique({
    where: { id: lessonId },
    select: {
      id: true,
      section: {
        select: {
          id: true,
          course: { select: { id: true, instructorId: true, tenantId: true } },
        },
      },
    },
  });
  if (!lesson) return null;

  return {
    lessonId: lesson.id,
    sectionId: lesson.section.id,
    courseId: lesson.section.course.id,
    instructorId: lesson.section.course.instructorId,
    tenantId: lesson.section.course.tenantId,
  };
}

/**
 * Entitlement for reading AI-derived content about a lesson (the summary).
 * Returns only the resolved ids — callers load content AFTER this passes, so
 * nothing about a lesson (cached summary, body text, existence) is observable
 * to an unentitled caller.
 *
 * - An ACTIVE or COMPLETED enrollment grants access, but only to lessons a
 *   learner can actually see: published, not archived, in a non-DRAFT course.
 *   (An ARCHIVED course stays reachable to enrolled learners, matching the
 *   lesson player.) A REFUNDED enrollment grants nothing.
 * - Without an enrollment, a lesson is reachable only when it is published,
 *   not archived, in a PUBLISHED course that belongs to the caller's tenant or
 *   to no tenant. Free lessons then pass; anything else that is visible needs
 *   enrollment (403).
 * - Everything else — missing, unpublished, archived, draft course, another
 *   tenant's course — is one indistinguishable 404, so a caller cannot probe
 *   whether a lesson id exists.
 *
 * There is no role-based shortcut: instructors, org admins and super admins
 * follow the same rules as any other user.
 */
export async function authorizeLessonSummaryAccess(
  user: { id: string; tenantId: string | null },
  lessonId: string
): Promise<{ lessonId: string; courseId: string }> {
  const lesson = await db.lesson.findUnique({
    where: { id: lessonId },
    select: {
      id: true,
      isFree: true,
      isPublished: true,
      isArchived: true,
      section: { select: { course: { select: { id: true, status: true, tenantId: true } } } },
    },
  });
  if (!lesson) throw new ContentAuthorizationError(404, "Lesson not found");

  const course = lesson.section.course;
  const granted = { lessonId: lesson.id, courseId: course.id };
  const lessonVisible = lesson.isPublished && !lesson.isArchived;

  const enrollment = await db.enrollment.findFirst({
    where: { userId: user.id, courseId: course.id, status: { in: ["ACTIVE", "COMPLETED"] } },
    select: { id: true },
  });
  if (enrollment) {
    if (lessonVisible && course.status !== "DRAFT") return granted;
    throw new ContentAuthorizationError(404, "Lesson not found");
  }

  const tenantCompatible = course.tenantId === null || course.tenantId === user.tenantId;
  if (!lessonVisible || course.status !== "PUBLISHED" || !tenantCompatible) {
    throw new ContentAuthorizationError(404, "Lesson not found");
  }
  if (lesson.isFree) return granted;
  throw new ContentAuthorizationError(403, "Not enrolled in this course");
}

/**
 * An instructor controls a course when they own it AND, if the course is
 * tenant-scoped, they belong to that same tenant. A course with no tenant (a
 * solo, FREE-plan course) is governed by ownership alone — the same rule
 * every sibling instructor route already applies (`instructorId` only).
 */
export function instructorControlsCourse(
  user: { id: string; tenantId: string | null },
  course: { instructorId: string; tenantId: string | null }
): boolean {
  if (course.instructorId !== user.id) return false;
  if (course.tenantId !== null && course.tenantId !== user.tenantId) return false;
  return true;
}

/** The subset of `lessonIds` that actually belong to `courseId`. */
export async function filterLessonIdsInCourse(
  courseId: string,
  lessonIds: string[]
): Promise<Set<string>> {
  if (lessonIds.length === 0) return new Set();
  const rows = await db.lesson.findMany({
    where: { id: { in: lessonIds }, section: { courseId } },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

/**
 * Authorization for the UploadThing videoUploader middleware. The client
 * supplies `lessonId`; it is never trusted on its own — the lesson's real
 * course is resolved server-side and the caller must control that course.
 * SUPER_ADMIN keeps its existing allowance (any lesson that exists).
 * Not-found and not-permitted are deliberately indistinguishable (404) so a
 * caller cannot probe whether another instructor's/tenant's lesson exists.
 */
export async function authorizeLessonVideoUpload(
  clerkId: string | null | undefined,
  lessonId: string
): Promise<{ userId: string; lessonId: string }> {
  if (!clerkId) throw new ContentAuthorizationError(401, "Unauthorized");

  const user = await db.user.findUnique({
    where: { clerkId },
    select: { id: true, role: true, tenantId: true },
  });
  if (!user) throw new ContentAuthorizationError(401, "User not found");
  if (user.role !== "INSTRUCTOR" && user.role !== "SUPER_ADMIN") {
    throw new ContentAuthorizationError(403, "Forbidden");
  }

  const chain = await resolveLessonChain(lessonId);
  if (!chain) throw new ContentAuthorizationError(404, "Lesson not found");

  if (user.role === "INSTRUCTOR" && !instructorControlsCourse(user, chain)) {
    throw new ContentAuthorizationError(404, "Lesson not found");
  }

  return { userId: clerkId, lessonId: chain.lessonId };
}
