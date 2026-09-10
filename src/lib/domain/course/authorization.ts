import { PLAN_LIMITS } from "@/constants/plans";
import { db } from "@/lib/db";

export class CourseAuthorizationError extends Error {
  constructor(
    public status: 403,
    message: string,
    public upgradeRequired = false
  ) {
    super(message);
    this.name = "CourseAuthorizationError";
  }
}

/**
 * Shared instructor-role + plan-limit gate for creating a new Course.
 * Extracted from POST /api/courses so a course created through the AI Course
 * Creator's save path (src/lib/domain/course-creator/saveDraft.ts) clears the
 * exact same bar as a human-authored one — same role check, same
 * PLAN_LIMITS.maxCourses ceiling, same instructorId scoping. `userId` is the
 * Prisma `User.id`, not the Clerk id.
 */
export async function assertCanCreateCourse(userId: string): Promise<void> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { role: true, plan: true },
  });

  if (!user || user.role !== "INSTRUCTOR") {
    throw new CourseAuthorizationError(403, "Forbidden");
  }

  const maxCourses = PLAN_LIMITS[user.plan].maxCourses;
  if (maxCourses !== Infinity) {
    const courseCount = await db.course.count({ where: { instructorId: userId } });
    if (courseCount >= maxCourses) {
      throw new CourseAuthorizationError(403, "Course limit reached for your plan", true);
    }
  }
}
