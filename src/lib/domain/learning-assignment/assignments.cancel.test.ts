import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  createMandatoryTraining,
  createScenario,
  createTeamWithMember,
  createTenant,
  createUserIn,
} from "@/lib/domain/learning-assignment/__test__/fixtures";
import {
  cancelAssignment,
  createMandatoryAssignment,
  createManualAssignment,
} from "@/lib/domain/learning-assignment/assignments";

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

async function assigned() {
  const scenario = await createScenario();
  const result = await createManualAssignment(scenario.admin.ctx, {
    userId: scenario.learner.user.id,
    courseId: scenario.course.id,
  });
  if (!result.ok) throw new Error(`setup failed: ${result.reason}`);
  return { ...scenario, assignment: result.assignment };
}

describe("cancelAssignment", () => {
  it("cancels, recording who and when, and keeps the row as history", async () => {
    const { admin, learner, course, assignment } = await assigned();

    const result = await cancelAssignment(admin.ctx, assignment.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("cancelled");
    const row = await db.learningAssignment.findUniqueOrThrow({ where: { id: assignment.id } });
    expect(row.cancelledAt).toBeInstanceOf(Date);
    expect(row.cancelledById).toBe(admin.user.id);
    expect(row.reason).toEqual(assignment.reason);
    expect(row.assignedById).toBe(assignment.assignedById);
    expect(
      await db.learningAssignment.count({ where: { userId: learner.user.id, courseId: course.id } })
    ).toBe(1);
  });

  it("does not unenroll the learner or touch progress, evidence or completion", async () => {
    const { admin, learner, course, lesson, assignment } = await assigned();
    await db.lessonProgress.create({
      data: {
        userId: learner.user.id,
        lessonId: lesson.id,
        isCompleted: true,
        completedAt: new Date(),
      },
    });
    const enrollmentBefore = await db.enrollment.findUniqueOrThrow({
      where: { userId_courseId: { userId: learner.user.id, courseId: course.id } },
    });
    const progressBefore = await db.lessonProgress.findMany({ where: { userId: learner.user.id } });
    const xpBefore = (await db.user.findUniqueOrThrow({ where: { id: learner.user.id } })).xpTotal;

    await cancelAssignment(admin.ctx, assignment.id);

    const enrollmentAfter = await db.enrollment.findUniqueOrThrow({
      where: { id: enrollmentBefore.id },
    });
    expect(enrollmentAfter).toEqual(enrollmentBefore);
    expect(await db.lessonProgress.findMany({ where: { userId: learner.user.id } })).toEqual(
      progressBefore
    );
    expect(await db.skillEvidence.count({ where: { userId: learner.user.id } })).toBe(0);
    expect(await db.learningEvent.count({ where: { userId: learner.user.id } })).toBe(0);
    expect((await db.user.findUniqueOrThrow({ where: { id: learner.user.id } })).xpTotal).toBe(
      xpBefore
    );
  });

  it("is idempotent: cancelling again reports already_cancelled and keeps the first cancellation", async () => {
    const { admin, tenant, assignment } = await assigned();
    const otherAdmin = await createUserIn(tenant.id, "ORG_ADMIN");

    await cancelAssignment(admin.ctx, assignment.id);
    const first = await db.learningAssignment.findUniqueOrThrow({ where: { id: assignment.id } });
    const again = await cancelAssignment(otherAdmin.ctx, assignment.id);

    expect(again.ok && again.outcome).toBe("already_cancelled");
    const after = await db.learningAssignment.findUniqueOrThrow({ where: { id: assignment.id } });
    expect(after.cancelledAt?.toISOString()).toBe(first.cancelledAt?.toISOString());
    expect(after.cancelledById).toBe(admin.user.id);
  });

  it("refuses to cancel a completed assignment and leaves it untouched", async () => {
    const { admin, learner, course, assignment } = await assigned();
    await db.enrollment.update({
      where: { userId_courseId: { userId: learner.user.id, courseId: course.id } },
      data: { status: "COMPLETED", completedAt: new Date() },
    });

    const result = await cancelAssignment(admin.ctx, assignment.id);

    expect(result).toEqual({ ok: false, reason: "ASSIGNMENT_COMPLETED" });
    const row = await db.learningAssignment.findUniqueOrThrow({ where: { id: assignment.id } });
    expect(row.cancelledAt).toBeNull();
    expect(row.cancelledById).toBeNull();
  });

  it("refuses when a completion commits while the cancellation is waiting on the enrollment lock", async () => {
    const { admin, learner, course, assignment } = await assigned();
    const where = { userId_courseId: { userId: learner.user.id, courseId: course.id } };

    let releaseCompletion: () => void = () => {};
    const completionMayCommit = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    let completionHoldsRow: () => void = () => {};
    const rowHeld = new Promise<void>((resolve) => {
      completionHoldsRow = resolve;
    });

    const completion = db.$transaction(async (tx) => {
      await tx.enrollment.update({
        where,
        data: { status: "COMPLETED", completedAt: new Date() },
      });
      completionHoldsRow();
      await completionMayCommit;
    });

    await rowHeld;
    const cancellation = cancelAssignment(admin.ctx, assignment.id);
    // Give the cancellation time to reach the lock and block behind the
    // uncommitted completion before it is allowed to commit.
    await new Promise((resolve) => setTimeout(resolve, 300));
    releaseCompletion();
    await completion;

    expect(await cancellation).toEqual({ ok: false, reason: "ASSIGNMENT_COMPLETED" });
    const row = await db.learningAssignment.findUniqueOrThrow({ where: { id: assignment.id } });
    expect(row.cancelledAt).toBeNull();
  });

  it("cannot cancel another tenant's assignment", async () => {
    const { assignment } = await assigned();
    const otherTenant = await createTenant();
    const otherAdmin = await createUserIn(otherTenant.id, "ORG_ADMIN");

    const result = await cancelAssignment(otherAdmin.ctx, assignment.id);
    const missing = await cancelAssignment(otherAdmin.ctx, "does-not-exist");

    expect(result).toEqual({ ok: false, reason: "ASSIGNMENT_NOT_FOUND" });
    expect(missing).toEqual(result);
    const row = await db.learningAssignment.findUniqueOrThrow({ where: { id: assignment.id } });
    expect(row.cancelledAt).toBeNull();
  });

  it("rejects STUDENT, INSTRUCTOR and SUPER_ADMIN actors with 403", async () => {
    const { tenant, learner, instructor, assignment } = await assigned();
    const superAdmin = await createUserIn(tenant.id, "SUPER_ADMIN");

    for (const actor of [learner, instructor, superAdmin]) {
      await expect(cancelAssignment(actor.ctx, assignment.id)).rejects.toMatchObject({
        name: "AuthContextError",
        status: 403,
      });
    }
    const row = await db.learningAssignment.findUniqueOrThrow({ where: { id: assignment.id } });
    expect(row.cancelledAt).toBeNull();
  });

  it("cancels only once when two cancellations race", async () => {
    const { admin, assignment } = await assigned();

    const results = await Promise.all([
      cancelAssignment(admin.ctx, assignment.id),
      cancelAssignment(admin.ctx, assignment.id),
      cancelAssignment(admin.ctx, assignment.id),
    ]);

    const outcomes = results.map((r) => (r.ok ? r.outcome : r.reason));
    expect(outcomes.filter((o) => o === "cancelled")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "already_cancelled")).toHaveLength(2);
  });
});

describe("reactivation through re-assignment", () => {
  it("reactivates the same row, preserving identity and provenance, without a new notification", async () => {
    const { admin, learner, course, assignment } = await assigned();
    const otherAdmin = await createUserIn(admin.ctx.tenantId, "ORG_ADMIN");
    await cancelAssignment(admin.ctx, assignment.id);
    const notificationsBefore = await db.notification.count({ where: { userId: learner.user.id } });

    const result = await createManualAssignment(otherAdmin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
      note: "a different note that must not replace the original",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("reactivated");
    expect(result.assignment.id).toBe(assignment.id);
    expect(result.assignment.cancelledAt).toBeNull();
    expect(result.assignment.cancelledById).toBeNull();
    expect(result.assignment.reason).toEqual(assignment.reason);
    expect(result.assignment.assignedById).toBe(admin.user.id);
    expect(result.status).toBe("ASSIGNED");
    expect(result.notificationCreated).toBe(false);
    expect(await db.learningAssignment.count({ where: { userId: learner.user.id } })).toBe(1);
    expect(await db.notification.count({ where: { userId: learner.user.id } })).toBe(
      notificationsBefore
    );
  });

  it("applies a newly supplied due date on reactivation", async () => {
    const { admin, learner, course } = await createScenario();
    const originalDue = new Date("2027-05-01T00:00:00.000Z");
    const newDue = new Date("2027-08-15T00:00:00.000Z");
    const created = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
      dueDate: originalDue,
      note: "original note",
    });
    if (!created.ok) throw new Error("setup");
    await cancelAssignment(admin.ctx, created.assignment.id);
    const notificationsBefore = await db.notification.count({ where: { userId: learner.user.id } });

    const result = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
      dueDate: newDue,
      note: "a different note that must not replace the original",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("reactivated");
    expect(result.assignment.id).toBe(created.assignment.id);
    expect(result.assignment.dueDate?.toISOString()).toBe(newDue.toISOString());

    const persisted = await db.learningAssignment.findUniqueOrThrow({
      where: { id: created.assignment.id },
    });
    expect(persisted.dueDate?.toISOString()).toBe(newDue.toISOString());
    expect(persisted.cancelledAt).toBeNull();
    expect(persisted.reason).toEqual(created.assignment.reason);
    expect(persisted.assignedById).toBe(created.assignment.assignedById);
    expect(await db.learningAssignment.count({ where: { userId: learner.user.id } })).toBe(1);
    expect(await db.notification.count({ where: { userId: learner.user.id } })).toBe(
      notificationsBefore
    );
  });

  it("keeps the previous due date on reactivation when none is supplied", async () => {
    const { admin, learner, course } = await createScenario();
    const originalDue = new Date("2027-05-01T00:00:00.000Z");
    const created = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
      dueDate: originalDue,
    });
    if (!created.ok) throw new Error("setup");
    await cancelAssignment(admin.ctx, created.assignment.id);

    const result = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
    });

    expect(result.ok && result.outcome).toBe("reactivated");
    const persisted = await db.learningAssignment.findUniqueOrThrow({
      where: { id: created.assignment.id },
    });
    expect(persisted.dueDate?.toISOString()).toBe(originalDue.toISOString());
  });

  it("re-validates the enrollment rules: an archived course stays cancelled", async () => {
    const { admin, learner, course, assignment } = await assigned();
    await cancelAssignment(admin.ctx, assignment.id);
    await db.course.update({ where: { id: course.id }, data: { status: "ARCHIVED" } });

    const result = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
    });

    expect(result).toEqual({ ok: false, reason: "COURSE_NOT_PUBLISHED" });
    const row = await db.learningAssignment.findUniqueOrThrow({ where: { id: assignment.id } });
    expect(row.cancelledAt).not.toBeNull();
  });

  it("reactivates exactly once when re-assignments race", async () => {
    const { admin, learner, course, assignment } = await assigned();
    await cancelAssignment(admin.ctx, assignment.id);

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        createManualAssignment(admin.ctx, { userId: learner.user.id, courseId: course.id })
      )
    );

    const outcomes = results.map((r) => (r.ok ? r.outcome : r.reason));
    expect(outcomes.filter((o) => o === "reactivated")).toHaveLength(1);
    expect(outcomes.every((o) => o === "reactivated" || o === "existing")).toBe(true);
    expect(await db.learningAssignment.count({ where: { userId: learner.user.id } })).toBe(1);
  });

  it("reactivates a cancelled mandatory assignment onto the same row", async () => {
    const scenario = await createScenario();
    const team = await createTeamWithMember(scenario.tenant.id, scenario.learner.user.id);
    const training = await createMandatoryTraining({
      tenantId: scenario.tenant.id,
      courseId: scenario.course.id,
      teamId: team.id,
    });
    const created = await createMandatoryAssignment(scenario.admin.ctx, {
      userId: scenario.learner.user.id,
      mandatoryTrainingId: training.id,
    });
    if (!created.ok) throw new Error("setup");
    await cancelAssignment(scenario.admin.ctx, created.assignment.id);

    const again = await createMandatoryAssignment(scenario.admin.ctx, {
      userId: scenario.learner.user.id,
      mandatoryTrainingId: training.id,
    });

    expect(again.ok && again.outcome).toBe("reactivated");
    expect(again.ok && again.assignment.id).toBe(created.assignment.id);
  });
});

describe("derived status after cancellation", () => {
  it("re-derives CANCELLED then back to ASSIGNED across cancel and reactivate", async () => {
    const { admin, learner, course, assignment } = await assigned();

    const cancelled = await cancelAssignment(admin.ctx, assignment.id);
    expect(cancelled.ok && cancelled.assignment.cancelledAt).not.toBeNull();

    const reactivated = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
    });
    expect(reactivated.ok && reactivated.status).toBe("ASSIGNED");
  });
});
