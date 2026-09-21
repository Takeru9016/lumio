import { db } from "@/lib/db";
import { createCourseIn, createScenario } from "@/lib/domain/learning-assignment/__test__/fixtures";

type CourseStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";
type EnrollmentStatus = "ACTIVE" | "COMPLETED" | "REFUNDED";

/**
 * A tenant with an admin, an instructor who owns every course made here, and a
 * learner, plus the helpers the prerequisite enforcement tests share. Edges are
 * written straight to the table: the rules for creating them are Phase 29.1's
 * and are tested there, and these tests are about what happens once they exist.
 */
export async function prerequisiteWorld() {
  const s = await createScenario();

  const make = async (overrides: { status?: CourseStatus; price?: number } = {}) =>
    (await createCourseIn(s.tenant.id, s.instructor.user.id, overrides)).course;

  const requires = (courseId: string, prerequisiteCourseId: string) =>
    db.coursePrerequisite.create({ data: { courseId, prerequisiteCourseId } });

  const enroll = (userId: string, courseId: string, status: EnrollmentStatus = "ACTIVE") =>
    db.enrollment.create({
      data: {
        userId,
        courseId,
        status,
        ...(status === "COMPLETED" ? { completedAt: new Date() } : {}),
      },
    });

  const complete = (userId: string, courseId: string) => enroll(userId, courseId, "COMPLETED");

  /** Flips an existing enrollment to COMPLETED the way the completion route does (one conditional update). */
  const completeExisting = (userId: string, courseId: string) =>
    db.enrollment.updateMany({
      where: { userId, courseId, status: { not: "COMPLETED" } },
      data: { status: "COMPLETED", completedAt: new Date() },
    });

  const archive = (courseId: string) =>
    db.course.update({ where: { id: courseId }, data: { status: "ARCHIVED" } });
  const unpublish = (courseId: string) =>
    db.course.update({ where: { id: courseId }, data: { status: "DRAFT" } });
  const removeLessons = (courseId: string) =>
    db.lesson.updateMany({ where: { section: { courseId } }, data: { isPublished: false } });
  const setPrice = (courseId: string, price: number) =>
    db.course.update({ where: { id: courseId }, data: { price, currency: "INR" } });

  return {
    ...s,
    make,
    requires,
    enroll,
    complete,
    completeExisting,
    archive,
    unpublish,
    removeLessons,
    setPrice,
    enrollmentCount: (userId: string, courseId: string) =>
      db.enrollment.count({ where: { userId, courseId } }),
  };
}

export type PrerequisiteWorld = Awaited<ReturnType<typeof prerequisiteWorld>>;
