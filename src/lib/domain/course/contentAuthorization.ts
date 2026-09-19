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
