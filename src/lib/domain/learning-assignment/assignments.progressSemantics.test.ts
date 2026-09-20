import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createScenario } from "@/lib/domain/learning-assignment/__test__/fixtures";
import { createManualAssignment } from "@/lib/domain/learning-assignment/assignments";
import { getLearnerAssignments } from "@/lib/domain/learning-assignment/learnerAssignments";
import { presentProgress } from "@/lib/learner-assignment-view";

afterAll(async () => {
  await db.$disconnect();
});

/**
 * L-5. The dashboard's "Continue learning" percentage counts only lessons that
 * are published and not archived (src/app/(student)/dashboard/page.tsx,
 * getCourseProgress). The assignment status "STARTED" means any LessonProgress
 * row exists in the course, hidden lessons included. These tests pin exactly
 * where the two disagree and that the learner UI handles it explicitly.
 */
async function dashboardPercent(userId: string, courseId: string): Promise<number> {
  const [total, completed] = await Promise.all([
    db.lesson.count({ where: { section: { courseId }, isPublished: true, isArchived: false } }),
    db.lessonProgress.count({
      where: {
        userId,
        isCompleted: true,
        lesson: { section: { courseId }, isPublished: true, isArchived: false },
      },
    }),
  ]);
  return total > 0 ? Math.round((completed / total) * 100) : 0;
}

async function setup() {
  const s = await createScenario();
  const secondLesson = await db.lesson.create({
    data: {
      title: "second",
      slug: `second-${Date.now()}-${Math.random()}`,
      type: "TEXT",
      order: 1,
      isPublished: true,
      sectionId: (await db.section.findFirstOrThrow({ where: { courseId: s.course.id } })).id,
    },
  });
  const result = await createManualAssignment(s.admin.ctx, {
    userId: s.learner.user.id,
    courseId: s.course.id,
  });
  if (!result.ok) throw new Error(`setup failed: ${result.reason}`);
  return { ...s, secondLesson };
}

async function statusOf(s: Awaited<ReturnType<typeof setup>>) {
  const [assignment] = await getLearnerAssignments(s.learner.ctx);
  return assignment.status;
}

describe("L-5 — assignment STARTED versus dashboard progress", () => {
  it("agree in the ordinary case: a completed, visible lesson is STARTED and shows a real percentage", async () => {
    const s = await setup();
    await db.lessonProgress.create({
      data: { userId: s.learner.user.id, lessonId: s.lesson.id, isCompleted: true },
    });

    const status = await statusOf(s);
    const percent = await dashboardPercent(s.learner.user.id, s.course.id);

    expect(status).toBe("STARTED");
    expect(percent).toBe(50);
    expect(presentProgress("STARTED", percent)).toEqual({ percent: 50, caveat: null });
  });

  it("disagree when the only completed lesson has since been unpublished: STARTED, 0%, and the UI explains it", async () => {
    const s = await setup();
    await db.lessonProgress.create({
      data: { userId: s.learner.user.id, lessonId: s.lesson.id, isCompleted: true },
    });
    await db.lesson.update({ where: { id: s.lesson.id }, data: { isPublished: false } });

    const status = await statusOf(s);
    const percent = await dashboardPercent(s.learner.user.id, s.course.id);

    expect(status).toBe("STARTED");
    expect(percent).toBe(0);
    expect(presentProgress(status, percent)?.caveat).toBe(
      "Progress counts only lessons that are currently published."
    );
  });

  it("disagree when the only completed lesson has since been archived", async () => {
    const s = await setup();
    await db.lessonProgress.create({
      data: { userId: s.learner.user.id, lessonId: s.lesson.id, isCompleted: true },
    });
    await db.lesson.update({ where: { id: s.lesson.id }, data: { isArchived: true } });

    expect(await statusOf(s)).toBe("STARTED");
    expect(await dashboardPercent(s.learner.user.id, s.course.id)).toBe(0);
  });

  it("the assignment status is never adjusted to match the percentage", async () => {
    const s = await setup();
    await db.lessonProgress.create({
      data: { userId: s.learner.user.id, lessonId: s.lesson.id, isCompleted: true },
    });
    await db.lesson.update({ where: { id: s.lesson.id }, data: { isPublished: false } });

    const before = await statusOf(s);
    await dashboardPercent(s.learner.user.id, s.course.id);

    expect(before).toBe("STARTED");
    expect(await statusOf(s)).toBe("STARTED");
  });

  it("an assignment with no progress at all is ASSIGNED and shows no bar", async () => {
    const s = await setup();

    const status = await statusOf(s);

    expect(status).toBe("ASSIGNED");
    expect(
      presentProgress(status, await dashboardPercent(s.learner.user.id, s.course.id))
    ).toBeNull();
  });
});
