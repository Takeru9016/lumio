import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { AuthContextError } from "@/lib/auth/context";
import { db } from "@/lib/db";
import {
  createCourseIn,
  createScenario,
  createTenant,
  createTenantlessStudent,
  createUserIn,
} from "@/lib/domain/learning-assignment/__test__/fixtures";
import { createManualAssignment } from "@/lib/domain/learning-assignment/assignments";

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

async function expectNothingWritten(userId: string, courseId: string) {
  expect(await db.learningAssignment.count({ where: { userId, courseId } })).toBe(0);
  expect(await db.enrollment.count({ where: { userId, courseId } })).toBe(0);
  expect(await db.notification.count({ where: { userId } })).toBe(0);
}

describe("createManualAssignment — creation", () => {
  it("creates the assignment, an ACTIVE enrollment and one notification", async () => {
    const { tenant, admin, learner, course } = await createScenario();

    const result = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("created");
    expect(result.status).toBe("ASSIGNED");
    expect(result.notificationCreated).toBe(true);
    expect(result.enrollment.created).toBe(true);
    expect(result.enrollment.status).toBe("ACTIVE");

    const assignment = await db.learningAssignment.findUniqueOrThrow({
      where: { id: result.assignment.id },
    });
    expect(assignment.tenantId).toBe(tenant.id);
    expect(assignment.userId).toBe(learner.user.id);
    expect(assignment.courseId).toBe(course.id);
    expect(assignment.source).toBe("MANUAL");
    expect(assignment.sourceKey).toBe(`manual:${course.id}`);
    expect(assignment.assignedById).toBe(admin.user.id);
    expect(assignment.mandatoryTrainingId).toBeNull();
    expect(assignment.cancelledAt).toBeNull();

    const enrollment = await db.enrollment.findUniqueOrThrow({
      where: { userId_courseId: { userId: learner.user.id, courseId: course.id } },
    });
    expect(enrollment.status).toBe("ACTIVE");
    expect(enrollment.id).toBe(result.enrollment.id);

    const notifications = await db.notification.findMany({ where: { userId: learner.user.id } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe("LEARNING_ASSIGNED");
    expect(notifications[0].tenantId).toBe(tenant.id);
    expect(notifications[0].dedupeKey).toBe(`assignment:${assignment.id}:assigned`);
    expect(notifications[0].link).toBe(`/courses/${course.slug}`);
  });

  it("reuses an existing ACTIVE enrollment instead of creating another", async () => {
    const { admin, learner, course } = await createScenario();
    const existing = await db.enrollment.create({
      data: { userId: learner.user.id, courseId: course.id },
    });

    const result = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.enrollment).toEqual({ id: existing.id, status: "ACTIVE", created: false });
    expect(result.status).toBe("ASSIGNED");
    expect(await db.enrollment.count({ where: { userId: learner.user.id } })).toBe(1);
  });

  it("accepts an existing COMPLETED enrollment: derives COMPLETED and sends no notification", async () => {
    const { admin, learner, course } = await createScenario();
    const completedAt = new Date("2026-08-01T00:00:00.000Z");
    const existing = await db.enrollment.create({
      data: { userId: learner.user.id, courseId: course.id, status: "COMPLETED", completedAt },
    });

    const result = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("COMPLETED");
    expect(result.notificationCreated).toBe(false);
    expect(result.enrollment).toEqual({ id: existing.id, status: "COMPLETED", created: false });
    expect(await db.notification.count({ where: { userId: learner.user.id } })).toBe(0);

    const after = await db.enrollment.findUniqueOrThrow({ where: { id: existing.id } });
    expect(after.status).toBe("COMPLETED");
    expect(after.completedAt?.toISOString()).toBe(completedAt.toISOString());
  });

  it("does not write evidence, XP or learning events", async () => {
    const { admin, learner, course } = await createScenario();
    const xpBefore = (await db.user.findUniqueOrThrow({ where: { id: learner.user.id } })).xpTotal;

    await createManualAssignment(admin.ctx, { userId: learner.user.id, courseId: course.id });

    expect(await db.skillEvidence.count({ where: { userId: learner.user.id } })).toBe(0);
    expect(await db.learningEvent.count({ where: { userId: learner.user.id } })).toBe(0);
    expect(await db.xPTransaction.count({ where: { userId: learner.user.id } })).toBe(0);
    expect((await db.user.findUniqueOrThrow({ where: { id: learner.user.id } })).xpTotal).toBe(
      xpBefore
    );
  });

  it("allows a free published course from the open catalogue (no tenant)", async () => {
    const { admin, learner, instructor } = await createScenario();
    const { course } = await createCourseIn(null, instructor.user.id);

    const result = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
    });

    expect(result.ok).toBe(true);
  });

  it("derives STARTED when the learner already has lesson progress", async () => {
    const { admin, learner, course, lesson } = await createScenario();
    await db.lessonProgress.create({ data: { userId: learner.user.id, lessonId: lesson.id } });

    const result = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
    });

    expect(result.ok && result.status).toBe("STARTED");
  });

  it("does not derive STARTED from another learner's progress on the same course", async () => {
    const { tenant, admin, learner, course, lesson } = await createScenario();
    const otherLearner = await createUserIn(tenant.id, "STUDENT");
    await db.lessonProgress.create({ data: { userId: otherLearner.user.id, lessonId: lesson.id } });

    const result = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
    });
    const control = await createManualAssignment(admin.ctx, {
      userId: otherLearner.user.id,
      courseId: course.id,
    });

    expect(result.ok && result.status).toBe("ASSIGNED");
    expect(control.ok && control.status).toBe("STARTED");
  });

  it("does not derive STARTED from the same learner's progress on a different course", async () => {
    const { tenant, admin, instructor, learner, course } = await createScenario();
    const { lesson: otherCourseLesson } = await createCourseIn(tenant.id, instructor.user.id);
    await db.lessonProgress.create({
      data: { userId: learner.user.id, lessonId: otherCourseLesson.id },
    });

    const result = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
    });

    expect(result.ok && result.status).toBe("ASSIGNED");
  });

  it("derives OVERDUE when the due date is already past", async () => {
    const { admin, learner, course } = await createScenario();

    const result = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
      dueDate: new Date("2020-01-01T00:00:00.000Z"),
    });

    expect(result.ok && result.status).toBe("OVERDUE");
  });
});

describe("createManualAssignment — idempotency", () => {
  it("returns the same assignment and creates nothing new on a repeat call", async () => {
    const { admin, learner, course } = await createScenario();
    const input = { userId: learner.user.id, courseId: course.id };

    const first = await createManualAssignment(admin.ctx, input);
    const second = await createManualAssignment(admin.ctx, input);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.outcome).toBe("existing");
    expect(second.assignment.id).toBe(first.assignment.id);
    expect(second.notificationCreated).toBe(false);
    expect(await db.learningAssignment.count({ where: { userId: learner.user.id } })).toBe(1);
    expect(await db.enrollment.count({ where: { userId: learner.user.id } })).toBe(1);
    expect(await db.notification.count({ where: { userId: learner.user.id } })).toBe(1);
  });

  it("creates exactly one assignment, enrollment and notification under concurrent calls", async () => {
    const { admin, learner, course } = await createScenario();
    const input = { userId: learner.user.id, courseId: course.id };

    const results = await Promise.all(
      Array.from({ length: 8 }, () => createManualAssignment(admin.ctx, input))
    );

    expect(results.every((r) => r.ok)).toBe(true);
    const ok = results.flatMap((r) => (r.ok ? [r] : []));
    expect(ok.filter((r) => r.outcome === "created")).toHaveLength(1);
    expect(ok.filter((r) => r.notificationCreated)).toHaveLength(1);
    expect(new Set(ok.map((r) => r.assignment.id)).size).toBe(1);
    expect(await db.learningAssignment.count({ where: { userId: learner.user.id } })).toBe(1);
    expect(await db.enrollment.count({ where: { userId: learner.user.id } })).toBe(1);
    expect(await db.notification.count({ where: { userId: learner.user.id } })).toBe(1);
  });

  it("keeps separate manual assignments for different courses and different learners", async () => {
    const { tenant, admin, instructor, learner, course } = await createScenario();
    const { course: otherCourse } = await createCourseIn(tenant.id, instructor.user.id);
    const otherLearner = await createUserIn(tenant.id, "STUDENT");

    const a = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
    });
    const b = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: otherCourse.id,
    });
    const c = await createManualAssignment(admin.ctx, {
      userId: otherLearner.user.id,
      courseId: course.id,
    });

    expect([a, b, c].every((r) => r.ok && r.outcome === "created")).toBe(true);
    expect(await db.learningAssignment.count({ where: { tenantId: tenant.id } })).toBe(3);
  });

  it("stores the due date and updates it when the same assignment is repeated with a new one", async () => {
    const { admin, learner, course } = await createScenario();
    const first = new Date("2027-03-01T23:59:59.999Z");
    const later = new Date("2027-04-01T23:59:59.999Z");

    const created = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
      dueDate: first,
    });
    const updated = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
      dueDate: later,
    });
    const untouched = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
    });

    expect(created.ok && created.assignment.dueDate?.toISOString()).toBe(first.toISOString());
    expect(updated.ok && updated.outcome).toBe("updated");
    expect(updated.ok && updated.assignment.dueDate?.toISOString()).toBe(later.toISOString());
    expect(untouched.ok && untouched.outcome).toBe("existing");
    expect(untouched.ok && untouched.assignment.dueDate?.toISOString()).toBe(later.toISOString());
    expect(await db.learningAssignment.count({ where: { userId: learner.user.id } })).toBe(1);
  });

  it("does not fail the assignment when the notification insert fails", async () => {
    const { admin, learner, course } = await createScenario();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(db.notification, "createMany").mockRejectedValueOnce(new Error("notification down"));

    const result = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notificationCreated).toBe(false);
    expect(await db.learningAssignment.count({ where: { userId: learner.user.id } })).toBe(1);
    expect(await db.notification.count({ where: { userId: learner.user.id } })).toBe(0);

    const retry = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
    });
    expect(retry.ok && retry.outcome).toBe("existing");
    expect(retry.ok && retry.notificationCreated).toBe(true);
    expect(await db.notification.count({ where: { userId: learner.user.id } })).toBe(1);
  });
});

describe("createManualAssignment — tenant isolation", () => {
  it("skips a learner in another tenant without writing anything", async () => {
    const { admin, course } = await createScenario();
    const otherTenant = await createTenant();
    const outsider = await createUserIn(otherTenant.id, "STUDENT");

    const result = await createManualAssignment(admin.ctx, {
      userId: outsider.user.id,
      courseId: course.id,
    });

    expect(result).toEqual({ ok: false, reason: "LEARNER_NOT_ELIGIBLE" });
    await expectNothingWritten(outsider.user.id, course.id);
  });

  it("reports an unknown learner exactly like a cross-tenant one", async () => {
    const { admin, course } = await createScenario();
    const otherTenant = await createTenant();
    const outsider = await createUserIn(otherTenant.id, "STUDENT");

    const cross = await createManualAssignment(admin.ctx, {
      userId: outsider.user.id,
      courseId: course.id,
    });
    const unknown = await createManualAssignment(admin.ctx, {
      userId: "does-not-exist",
      courseId: course.id,
    });

    expect(unknown).toEqual(cross);
  });

  it("skips a learner with no tenant", async () => {
    const { admin, course } = await createScenario();
    const solo = await createTenantlessStudent();

    const result = await createManualAssignment(admin.ctx, {
      userId: solo.id,
      courseId: course.id,
    });

    expect(result).toEqual({ ok: false, reason: "LEARNER_NOT_ELIGIBLE" });
    await expectNothingWritten(solo.id, course.id);
  });

  it("rejects another tenant's course and creates no enrollment", async () => {
    const { admin, learner } = await createScenario();
    const otherTenant = await createTenant();
    const otherInstructor = await createUserIn(otherTenant.id, "INSTRUCTOR");
    const { course: foreignCourse } = await createCourseIn(otherTenant.id, otherInstructor.user.id);

    const result = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: foreignCourse.id,
    });

    expect(result).toEqual({ ok: false, reason: "COURSE_NOT_FOUND" });
    await expectNothingWritten(learner.user.id, foreignCourse.id);
  });

  it("reports a missing course exactly like another tenant's course", async () => {
    const { admin, learner } = await createScenario();

    const result = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: "does-not-exist",
    });

    expect(result).toEqual({ ok: false, reason: "COURSE_NOT_FOUND" });
  });

  it("always takes the tenant from the authenticated actor, never from the input", async () => {
    const { tenant, admin, learner, course } = await createScenario();
    const otherTenant = await createTenant();

    const result = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
      tenantId: otherTenant.id,
    } as never);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assignment.tenantId).toBe(tenant.id);
    const notification = await db.notification.findFirstOrThrow({
      where: { userId: learner.user.id },
    });
    expect(notification.tenantId).toBe(tenant.id);
  });

  it("refuses to reuse a same-key assignment row that belongs to another tenant", async () => {
    const { admin, learner, course } = await createScenario();
    const otherTenant = await createTenant();
    await db.learningAssignment.create({
      data: {
        tenantId: otherTenant.id,
        userId: learner.user.id,
        courseId: course.id,
        source: "MANUAL",
        sourceKey: `manual:${course.id}`,
        reason: {},
      },
    });

    const result = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
    });

    expect(result).toEqual({ ok: false, reason: "ASSIGNMENT_CONFLICT" });
    expect(await db.notification.count({ where: { userId: learner.user.id } })).toBe(0);
    expect(await db.enrollment.count({ where: { userId: learner.user.id } })).toBe(0);
  });
});

describe("createManualAssignment — enrollment authorization", () => {
  it("rejects a draft course", async () => {
    const { tenant, admin, learner, instructor } = await createScenario();
    const { course } = await createCourseIn(tenant.id, instructor.user.id, { status: "DRAFT" });

    const result = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
    });

    expect(result).toEqual({ ok: false, reason: "COURSE_NOT_PUBLISHED" });
    await expectNothingWritten(learner.user.id, course.id);
  });

  it("rejects an archived course", async () => {
    const { tenant, admin, learner, instructor } = await createScenario();
    const { course } = await createCourseIn(tenant.id, instructor.user.id, {
      status: "ARCHIVED",
    });

    const result = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
    });

    expect(result).toEqual({ ok: false, reason: "COURSE_NOT_PUBLISHED" });
    await expectNothingWritten(learner.user.id, course.id);
  });

  it("rejects a paid course and creates no enrollment", async () => {
    const { tenant, admin, learner, instructor } = await createScenario();
    const { course } = await createCourseIn(tenant.id, instructor.user.id, { price: 499 });

    const result = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
    });

    expect(result).toEqual({ ok: false, reason: "COURSE_REQUIRES_PAYMENT" });
    await expectNothingWritten(learner.user.id, course.id);
  });

  it("rejects a learner who is not a student", async () => {
    const { tenant, admin, course } = await createScenario();
    const otherInstructor = await createUserIn(tenant.id, "INSTRUCTOR");
    const otherAdmin = await createUserIn(tenant.id, "ORG_ADMIN");

    for (const target of [otherInstructor, otherAdmin]) {
      const result = await createManualAssignment(admin.ctx, {
        userId: target.user.id,
        courseId: course.id,
      });
      expect(result).toEqual({ ok: false, reason: "LEARNER_NOT_ELIGIBLE" });
      await expectNothingWritten(target.user.id, course.id);
    }
  });

  it("rejects a deleted learner", async () => {
    const { admin, learner, course } = await createScenario();
    await db.user.update({ where: { id: learner.user.id }, data: { deletedAt: new Date() } });

    const result = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
    });

    expect(result).toEqual({ ok: false, reason: "LEARNER_NOT_ELIGIBLE" });
    await expectNothingWritten(learner.user.id, course.id);
  });

  it("rejects a learner whose enrollment was refunded and leaves it refunded", async () => {
    const { admin, learner, course } = await createScenario();
    const refunded = await db.enrollment.create({
      data: { userId: learner.user.id, courseId: course.id, status: "REFUNDED" },
    });

    const result = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
    });

    expect(result).toEqual({ ok: false, reason: "ENROLLMENT_REFUNDED" });
    expect(await db.learningAssignment.count({ where: { userId: learner.user.id } })).toBe(0);
    expect(await db.notification.count({ where: { userId: learner.user.id } })).toBe(0);
    const after = await db.enrollment.findUniqueOrThrow({ where: { id: refunded.id } });
    expect(after.status).toBe("REFUNDED");
  });
});

describe("createManualAssignment — actor authorization", () => {
  it("rejects a STUDENT actor with 403 and writes nothing", async () => {
    const { tenant, learner, course } = await createScenario();
    const peer = await createUserIn(tenant.id, "STUDENT");

    await expect(
      createManualAssignment(peer.ctx, { userId: learner.user.id, courseId: course.id })
    ).rejects.toMatchObject({ name: "AuthContextError", status: 403 });
    await expectNothingWritten(learner.user.id, course.id);
  });

  it("rejects an INSTRUCTOR actor with 403", async () => {
    const { instructor, learner, course } = await createScenario();

    await expect(
      createManualAssignment(instructor.ctx, { userId: learner.user.id, courseId: course.id })
    ).rejects.toBeInstanceOf(AuthContextError);
    await expectNothingWritten(learner.user.id, course.id);
  });

  it("rejects a SUPER_ADMIN actor with 403", async () => {
    const { tenant, learner, course } = await createScenario();
    const superAdmin = await createUserIn(tenant.id, "SUPER_ADMIN");

    await expect(
      createManualAssignment(superAdmin.ctx, { userId: learner.user.id, courseId: course.id })
    ).rejects.toMatchObject({ status: 403 });
    await expectNothingWritten(learner.user.id, course.id);
  });

  it("rejects an ORG_ADMIN with no tenant with 400", async () => {
    const { learner, course } = await createScenario();
    const admin = await createUserIn((await createTenant()).id, "ORG_ADMIN");

    await expect(
      createManualAssignment(
        { ...admin.ctx, tenantId: null },
        { userId: learner.user.id, courseId: course.id }
      )
    ).rejects.toMatchObject({ status: 400 });
    await expectNothingWritten(learner.user.id, course.id);
  });
});

describe("createManualAssignment — input validation", () => {
  it("rejects an invalid due date", async () => {
    const { admin, learner, course } = await createScenario();

    const result = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
      dueDate: new Date("not a date"),
    });

    expect(result).toEqual({ ok: false, reason: "INVALID_INPUT" });
    await expectNothingWritten(learner.user.id, course.id);
  });

  it("rejects a note longer than 500 characters", async () => {
    const { admin, learner, course } = await createScenario();

    const result = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
      note: "x".repeat(501),
    });

    expect(result).toEqual({ ok: false, reason: "INVALID_INPUT" });
    await expectNothingWritten(learner.user.id, course.id);
  });
});
