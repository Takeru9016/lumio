import { db } from "@/lib/db";
import { createUserIn } from "@/lib/domain/learning-assignment/__test__/fixtures";
import { pathWorld } from "@/lib/domain/learning-path/__test__/pathWorld";

type EnrollmentStatus = "ACTIVE" | "COMPLETED" | "REFUNDED";

/**
 * The admin path world plus what the learner read needs: enrollments, prerequisite
 * edges written straight to the table, and the ways a course drifts after a path is
 * published. `learner` is the STUDENT whose view is under test.
 */
export async function learnerWorld() {
  const w = await pathWorld();

  const enroll = (userId: string, courseId: string, status: EnrollmentStatus = "ACTIVE") =>
    db.enrollment.create({
      data: {
        userId,
        courseId,
        status,
        ...(status === "COMPLETED" ? { completedAt: new Date() } : {}),
      },
    });

  /** The learner under test completes a course. */
  const complete = (courseId: string, userId = w.learner.user.id) =>
    enroll(userId, courseId, "COMPLETED");

  const requires = (courseId: string, prerequisiteCourseId: string) =>
    db.coursePrerequisite.create({ data: { courseId, prerequisiteCourseId } });

  const unpublish = (id: string) => db.course.update({ where: { id }, data: { status: "DRAFT" } });
  const removeLessons = (id: string) =>
    db.lesson.updateMany({ where: { section: { courseId: id } }, data: { isPublished: false } });

  const publishedPath = (courses: { id: string }[], title?: string) =>
    w.makePath({ status: "PUBLISHED", courses, title });

  const otherLearner = () => createUserIn(w.tenant.id, "STUDENT");

  return {
    ...w,
    enroll,
    complete,
    requires,
    unpublish,
    removeLessons,
    publishedPath,
    otherLearner,
  };
}

export type LearnerWorld = Awaited<ReturnType<typeof learnerWorld>>;

/** The HTTP status of an AuthContextError, or the code of a LearningPathError, or null. */
export async function refusalOf(call: () => Promise<unknown>): Promise<string | number | null> {
  try {
    await call();
    return null;
  } catch (err) {
    if (typeof err === "object" && err !== null) {
      if ("code" in err) return String((err as { code: unknown }).code);
      if ("status" in err) return Number((err as { status: unknown }).status);
    }
    return `UNEXPECTED:${String(err)}`;
  }
}
