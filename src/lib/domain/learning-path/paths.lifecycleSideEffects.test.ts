import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createManualAssignment } from "@/lib/domain/learning-assignment/assignments";
import { pathWorld } from "@/lib/domain/learning-path/__test__/pathWorld";
import { archiveLearningPath, publishLearningPath } from "@/lib/domain/learning-path/paths";

afterAll(async () => {
  await db.$disconnect();
});

describe("lifecycle changes have no side effects beyond the path's own status", () => {
  it("publishing, archiving and republishing leave every learner-facing table exactly as it was", async () => {
    const w = await pathWorld();
    const [a, b, c] = await w.makeMany(3);
    if (!a || !b || !c) throw new Error("fixture");
    await db.coursePrerequisite.create({ data: { courseId: b.id, prerequisiteCourseId: a.id } });
    const assigned = await createManualAssignment(w.admin.ctx, {
      userId: w.learner.user.id,
      courseId: a.id,
      dueDate: undefined,
      note: undefined,
    });
    expect(assigned.ok).toBe(true);
    const lesson = await db.lesson.findFirstOrThrow({ where: { section: { courseId: a.id } } });
    await db.lessonProgress.create({
      data: { userId: w.learner.user.id, lessonId: lesson.id, watchedSecs: 30 },
    });
    await db.aIUsageEvent.create({
      data: {
        tenantId: w.tenant.id,
        userId: w.learner.user.id,
        operation: "tutor",
        provider: "test",
        model: "test",
      },
    });
    const path = await w.makePath({ courses: [b, a, c] });

    const courseIds = [a.id, b.id, c.id];
    const learnerId = w.learner.user.id;
    const snapshot = async () => ({
      enrollments: await db.enrollment.findMany({
        where: { userId: learnerId },
        orderBy: { id: "asc" },
      }),
      lessonProgress: await db.lessonProgress.findMany({
        where: { userId: learnerId },
        orderBy: { id: "asc" },
      }),
      assignments: await db.learningAssignment.findMany({
        where: { tenantId: w.tenant.id },
        orderBy: { id: "asc" },
      }),
      notifications: await db.notification.findMany({
        where: { userId: learnerId },
        orderBy: { id: "asc" },
      }),
      events: await db.learningEvent.findMany({
        where: { userId: learnerId },
        orderBy: { id: "asc" },
      }),
      evidence: await db.skillEvidence.findMany({
        where: { userId: learnerId },
        orderBy: { id: "asc" },
      }),
      prerequisites: await db.coursePrerequisite.findMany({
        where: { courseId: { in: courseIds } },
        orderBy: { id: "asc" },
      }),
      courses: await db.course.findMany({
        where: { id: { in: courseIds } },
        orderBy: { id: "asc" },
      }),
      lessons: await db.lesson.findMany({
        where: { section: { courseId: { in: courseIds } } },
        orderBy: { id: "asc" },
      }),
      aiUsage: await db.aIUsageEvent.findMany({
        where: { tenantId: w.tenant.id },
        orderBy: { id: "asc" },
      }),
      members: await db.learningPathCourse.findMany({
        where: { pathId: path.id },
        orderBy: { id: "asc" },
      }),
    });
    const counts = await w.sideEffects();
    const globalExtras = async () => ({
      progress: await db.lessonProgress.count(),
      aiUsage: await db.aIUsageEvent.count(),
      paths: await db.learningPath.count(),
      memberships: await db.learningPathCourse.count(),
    });
    const extrasBefore = await globalExtras();
    const completedBefore = await db.learningEvent.count({
      where: { eventType: "LEARNING_PATH_COMPLETED" },
    });
    const before = await snapshot();
    expect(before.enrollments.length).toBeGreaterThan(0);
    expect(before.assignments.length).toBeGreaterThan(0);
    expect(before.notifications.length).toBeGreaterThan(0);
    expect(before.lessonProgress).toHaveLength(1);
    expect(before.aiUsage).toHaveLength(1);
    expect(before.prerequisites).toHaveLength(1);

    await publishLearningPath(w.admin.ctx, path.id);
    await archiveLearningPath(w.admin.ctx, path.id);
    await publishLearningPath(w.admin.ctx, path.id);
    await archiveLearningPath(w.admin.ctx, path.id);

    expect(await w.sideEffects()).toEqual(counts);
    expect(await globalExtras()).toEqual(extrasBefore);
    expect(await snapshot()).toEqual(before);
    expect(await db.learningEvent.count({ where: { eventType: "LEARNING_PATH_COMPLETED" } })).toBe(
      completedBefore
    );
  });

  it("a refused publish or archive writes nothing at all", async () => {
    const w = await pathWorld();
    const bad = await w.make({ status: "DRAFT" });
    const draft = await w.makePath({ courses: [bad] });
    const archived = await w.makePath({ status: "ARCHIVED" });
    const rowsBefore = await db.learningPath.findMany({
      where: { id: { in: [draft.id, archived.id] } },
      orderBy: { id: "asc" },
    });
    const counts = await w.sideEffects();

    for (const call of [
      () => publishLearningPath(w.admin.ctx, draft.id),
      () => archiveLearningPath(w.admin.ctx, archived.id),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(Error);
    }

    expect(
      await db.learningPath.findMany({
        where: { id: { in: [draft.id, archived.id] } },
        orderBy: { id: "asc" },
      })
    ).toEqual(rowsBefore);
    expect(await w.sideEffects()).toEqual(counts);
  });
});
