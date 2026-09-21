import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createManualAssignment } from "@/lib/domain/learning-assignment/assignments";
import { pathWorld } from "@/lib/domain/learning-path/__test__/pathWorld";
import {
  addCourseToLearningPath,
  createLearningPath,
  getLearningPathForAdmin,
  listLearningPathsForAdmin,
  removeCourseFromLearningPath,
  reorderLearningPath,
  updateLearningPath,
} from "@/lib/domain/learning-path/paths";

afterAll(async () => {
  await db.$disconnect();
});

describe("path operations have no side effects beyond the path", () => {
  it("creating, editing, listing, reading, adding, reordering and removing leave every learner-facing table exactly as it was", async () => {
    const w = await pathWorld();
    const [a, b, c] = await w.makeMany(3);
    if (!a || !b || !c) throw new Error("fixture");
    await db.coursePrerequisite.create({ data: { courseId: b.id, prerequisiteCourseId: a.id } });
    // A real assignment: it brings an enrollment and a notification into being, so
    // the "unchanged" comparison below is over rows that exist, not empty tables.
    const assigned = await createManualAssignment(w.admin.ctx, {
      userId: w.learner.user.id,
      courseId: a.id,
      dueDate: undefined,
      note: undefined,
    });
    expect(assigned.ok).toBe(true);

    const courseIds = [a.id, b.id, c.id];
    const learnerId = w.learner.user.id;
    const tenantRows = async () => ({
      enrollments: await db.enrollment.findMany({
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
    });
    const counts = await w.sideEffects();
    const before = await tenantRows();
    expect(before.enrollments.length).toBeGreaterThan(0);
    expect(before.assignments.length).toBeGreaterThan(0);
    expect(before.notifications.length).toBeGreaterThan(0);
    expect(before.prerequisites).toHaveLength(1);

    const ctx = w.admin.ctx;
    const path = await createLearningPath(ctx, { title: "Journey", description: "About" });
    await updateLearningPath(ctx, path.id, { title: "Renamed" });
    // b before a: an order that contradicts the prerequisite, and it must not matter.
    for (const course of [b, a, c]) {
      await addCourseToLearningPath(ctx, path.id, { courseId: course.id });
    }
    await reorderLearningPath(ctx, path.id, { courseIds: [c.id, b.id, a.id] });
    await getLearningPathForAdmin(ctx, path.id);
    await listLearningPathsForAdmin(ctx);
    await removeCourseFromLearningPath(ctx, path.id, a.id);

    expect(await w.sideEffects()).toEqual(counts);
    expect(await tenantRows()).toEqual(before);
  });

  it("puts no other row anywhere: a path, its memberships and nothing else are new", async () => {
    const w = await pathWorld();
    const [a, b] = await w.makeMany(2);
    if (!a || !b) throw new Error("fixture");
    const tables = async () => ({
      users: await db.user.count(),
      tenants: await db.tenant.count(),
      teams: await db.team.count(),
      progress: await db.lessonProgress.count(),
      certificates: await db.certificate.count(),
      audit: await db.adminAuditLog.count(),
      xp: await db.xPTransaction.count(),
      paths: await db.learningPath.count(),
      memberships: await db.learningPathCourse.count(),
    });
    const before = await tables();

    const path = await createLearningPath(w.admin.ctx, { title: "Journey" });
    await addCourseToLearningPath(w.admin.ctx, path.id, { courseId: a.id });
    await addCourseToLearningPath(w.admin.ctx, path.id, { courseId: b.id });

    expect(await tables()).toEqual({
      ...before,
      paths: before.paths + 1,
      memberships: before.memberships + 2,
    });
  });
});
