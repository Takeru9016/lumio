import { db } from "@/lib/db";

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

export async function createSkill(tenantId: string, name = unique("skill")) {
  return db.skill.create({
    data: { tenantId, name, slug: unique("skill-slug") },
  });
}

/** A minimal Course + one Section + one published TEXT Lesson, owned by `instructorId`. */
export async function createCourse(tenantId: string, instructorId: string) {
  const course = await db.course.create({
    data: {
      title: unique("course"),
      slug: unique("course-slug"),
      instructorId,
      tenantId,
    },
  });
  const section = await db.section.create({
    data: { title: unique("section"), order: 0, courseId: course.id },
  });
  const lesson = await db.lesson.create({
    data: {
      title: unique("lesson"),
      slug: unique("lesson-slug"),
      type: "TEXT",
      order: 0,
      isPublished: true,
      sectionId: section.id,
    },
  });
  return { course, section, lesson };
}

export async function mapCourseSkill(courseId: string, skillId: string) {
  return db.courseSkill.create({ data: { courseId, skillId } });
}

/** Adds a Quiz to an existing lesson (a lesson can hold at most one Quiz). */
export async function createQuiz(lessonId: string, passingScore = 70) {
  return db.quiz.create({
    data: { title: unique("quiz"), passingScore, lessonId },
  });
}

export async function createQuizAttempt(
  userId: string,
  quizId: string,
  score: number,
  isPassed: boolean
) {
  return db.quizAttempt.create({
    data: { userId, quizId, score, isPassed },
  });
}

export async function createJobRole(tenantId: string, name = unique("role")) {
  return db.jobRole.create({
    data: { tenantId, name, slug: unique("role-slug") },
  });
}

export async function createRoleSkill(
  roleId: string,
  skillId: string,
  requiredProficiency: "NONE" | "BEGINNER" | "INTERMEDIATE" | "ADVANCED" | "EXPERT" = "BEGINNER",
  isRequired = true
) {
  return db.roleSkill.create({
    data: { roleId, skillId, requiredProficiency, isRequired },
  });
}

export async function createUserJobRole(
  tenantId: string,
  userId: string,
  roleId: string,
  isPrimary = true,
  assignedAt = new Date()
) {
  return db.userJobRole.create({
    data: { tenantId, userId, roleId, isPrimary, assignedAt },
  });
}
