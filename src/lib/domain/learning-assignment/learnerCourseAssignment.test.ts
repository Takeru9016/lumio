import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { AuthContextError } from "@/lib/auth/context";
import { db } from "@/lib/db";
import {
  createCourseIn,
  createMandatoryTraining,
  createScenario,
  createTeamWithMember,
  createTenant,
  createTenantlessStudent,
  createUserIn,
} from "@/lib/domain/learning-assignment/__test__/fixtures";
import {
  cancelAssignment,
  createMandatoryAssignment,
  createManualAssignment,
} from "@/lib/domain/learning-assignment/assignments";
import {
  getLearnerAssignments,
  getLearnerCourseAssignment,
} from "@/lib/domain/learning-assignment/learnerAssignments";

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

type Scenario = Awaited<ReturnType<typeof createScenario>>;

async function assign(
  s: Scenario,
  courseId: string,
  extra: { dueDate?: Date | null; note?: string } = {}
) {
  const result = await createManualAssignment(s.admin.ctx, {
    userId: s.learner.user.id,
    courseId,
    ...(extra.dueDate !== undefined ? { dueDate: extra.dueDate } : {}),
    ...(extra.note !== undefined ? { note: extra.note } : {}),
  });
  if (!result.ok) throw new Error(`setup failed: ${result.reason}`);
  return result.assignment;
}

async function extraCourse(s: Scenario) {
  return createCourseIn(s.tenant.id, s.instructor.user.id);
}

describe("getLearnerCourseAssignment — course scoping", () => {
  it("returns the assignment for the requested course and not for another course", async () => {
    const s = await createScenario();
    const b = await extraCourse(s);
    const forA = await assign(s, s.course.id);

    const a = await getLearnerCourseAssignment(s.learner.ctx, s.course.id);
    const other = await getLearnerCourseAssignment(s.learner.ctx, b.course.id);

    expect(a?.id).toBe(forA.id);
    expect(a?.courseId).toBe(s.course.id);
    expect(other).toBeNull();
  });

  it("with assignments in both courses, each course returns its own", async () => {
    const s = await createScenario();
    const b = await extraCourse(s);
    const forA = await assign(s, s.course.id);
    const forB = await assign(s, b.course.id);

    expect((await getLearnerCourseAssignment(s.learner.ctx, s.course.id))?.id).toBe(forA.id);
    expect((await getLearnerCourseAssignment(s.learner.ctx, b.course.id))?.id).toBe(forB.id);
  });

  it("returns null for an unknown course id, without throwing", async () => {
    const s = await createScenario();
    await assign(s, s.course.id);

    expect(await getLearnerCourseAssignment(s.learner.ctx, "does-not-exist")).toBeNull();
  });

  it("does not return another learner's assignment for the same course", async () => {
    const s = await createScenario();
    const other = await createUserIn(s.tenant.id, "STUDENT");
    await assign(s, s.course.id);

    expect(await getLearnerCourseAssignment(other.ctx, s.course.id)).toBeNull();
  });

  it("does not return a foreign tenant's assignment, even with that tenant's ids", async () => {
    const a = await createScenario();
    const b = await createScenario();
    await assign(b, b.course.id);

    expect(await getLearnerCourseAssignment(a.learner.ctx, b.course.id)).toBeNull();
    expect(
      await getLearnerCourseAssignment({ ...b.learner.ctx, tenantId: a.tenant.id }, b.course.id)
    ).toBeNull();
    expect(await getLearnerCourseAssignment(b.learner.ctx, b.course.id)).not.toBeNull();
  });

  it("hides a row that belongs to a previous tenant of the same learner", async () => {
    const s = await createScenario();
    const previous = await createTenant();
    await db.learningAssignment.create({
      data: {
        tenantId: previous.id,
        userId: s.learner.user.id,
        courseId: s.course.id,
        source: "MANUAL",
        sourceKey: `manual:${s.course.id}`,
        reason: { assignedById: "x", assignedByName: "Old admin" },
      },
    });

    expect(await getLearnerCourseAssignment(s.learner.ctx, s.course.id)).toBeNull();
  });

  it("does not return a cancelled assignment, and returns it again once reactivated", async () => {
    const s = await createScenario();
    const assignment = await assign(s, s.course.id);
    await cancelAssignment(s.admin.ctx, assignment.id);

    expect(await getLearnerCourseAssignment(s.learner.ctx, s.course.id)).toBeNull();

    await assign(s, s.course.id);
    expect((await getLearnerCourseAssignment(s.learner.ctx, s.course.id))?.id).toBe(assignment.id);
  });
});

describe("getLearnerCourseAssignment — status and projection", () => {
  const now = new Date("2026-09-20T12:00:00.000Z");

  it("ASSIGNED: no progress, not overdue", async () => {
    const s = await createScenario();
    await assign(s, s.course.id, { dueDate: new Date("2027-01-01T00:00:00.000Z") });

    expect((await getLearnerCourseAssignment(s.learner.ctx, s.course.id, now))?.status).toBe(
      "ASSIGNED"
    );
  });

  it("STARTED: a LessonProgress row exists in the course", async () => {
    const s = await createScenario();
    await assign(s, s.course.id);
    await db.lessonProgress.create({
      data: { userId: s.learner.user.id, lessonId: s.lesson.id, isCompleted: true },
    });

    expect((await getLearnerCourseAssignment(s.learner.ctx, s.course.id, now))?.status).toBe(
      "STARTED"
    );
  });

  it("STARTED still counts progress on a lesson that is no longer published (L-5 unchanged)", async () => {
    const s = await createScenario();
    await assign(s, s.course.id);
    await db.lessonProgress.create({
      data: { userId: s.learner.user.id, lessonId: s.lesson.id, isCompleted: true },
    });
    await db.lesson.update({ where: { id: s.lesson.id }, data: { isPublished: false } });

    expect((await getLearnerCourseAssignment(s.learner.ctx, s.course.id, now))?.status).toBe(
      "STARTED"
    );
  });

  it("OVERDUE: the due date has passed and the course is not complete", async () => {
    const s = await createScenario();
    await assign(s, s.course.id, { dueDate: new Date("2026-09-01T00:00:00.000Z") });

    expect((await getLearnerCourseAssignment(s.learner.ctx, s.course.id, now))?.status).toBe(
      "OVERDUE"
    );
  });

  it("COMPLETED wins over OVERDUE once the enrollment is completed", async () => {
    const s = await createScenario();
    await assign(s, s.course.id, { dueDate: new Date("2026-09-01T00:00:00.000Z") });
    await db.enrollment.update({
      where: { userId_courseId: { userId: s.learner.user.id, courseId: s.course.id } },
      data: { status: "COMPLETED", completedAt: new Date() },
    });

    expect((await getLearnerCourseAssignment(s.learner.ctx, s.course.id, now))?.status).toBe(
      "COMPLETED"
    );
  });

  it("keeps the due date, the learner-facing reason and the course slug", async () => {
    const s = await createScenario();
    const due = new Date("2027-03-01T23:59:59.999Z");
    await assign(s, s.course.id, { dueDate: due, note: "Before onboarding." });

    const found = await getLearnerCourseAssignment(s.learner.ctx, s.course.id);

    expect(found).toMatchObject({
      courseSlug: s.course.slug,
      courseTitle: s.course.title,
      dueDate: due,
      source: "MANUAL",
      reason: { assignedByName: s.admin.user.name, note: "Before onboarding." },
    });
    expect(JSON.stringify(found)).not.toContain(s.admin.user.id);
  });

  it("with several assignments for one course, returns the one due first, as the collection read orders them", async () => {
    const s = await createScenario();
    const team = await createTeamWithMember(s.tenant.id, s.learner.user.id);
    const training = await createMandatoryTraining({
      tenantId: s.tenant.id,
      courseId: s.course.id,
      teamId: team.id,
      dueDate: new Date("2098-01-01T00:00:00.000Z"),
    });
    await assign(s, s.course.id, { dueDate: new Date("2099-01-01T00:00:00.000Z") });
    const mandatory = await createMandatoryAssignment(s.admin.ctx, {
      userId: s.learner.user.id,
      mandatoryTrainingId: training.id,
    });
    expect(mandatory.ok).toBe(true);

    const scoped = await getLearnerCourseAssignment(s.learner.ctx, s.course.id);
    const [collectionFirst] = await getLearnerAssignments(s.learner.ctx);

    expect(scoped?.source).toBe("MANDATORY");
    expect(scoped).toEqual(collectionFirst);
  });
});

describe("getLearnerCourseAssignment — the due-first assignment wins, whichever source it is", () => {
  // The database hands rows back in index order (source, not insertion), so the
  // order the rows arrive in must not decide the answer: cover both sources as
  // the earlier-due one.
  it.each([
    ["MANDATORY", "2098-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z"],
    ["MANUAL", "2099-01-01T00:00:00.000Z", "2098-01-01T00:00:00.000Z"],
  ] as const)(
    "%s is returned when it is the one due first",
    async (expected, mandatoryDue, manualDue) => {
      const s = await createScenario();
      const team = await createTeamWithMember(s.tenant.id, s.learner.user.id);
      const training = await createMandatoryTraining({
        tenantId: s.tenant.id,
        courseId: s.course.id,
        teamId: team.id,
        dueDate: new Date(mandatoryDue),
      });
      await assign(s, s.course.id, { dueDate: new Date(manualDue) });
      const mandatory = await createMandatoryAssignment(s.admin.ctx, {
        userId: s.learner.user.id,
        mandatoryTrainingId: training.id,
      });
      expect(mandatory.ok).toBe(true);

      const scoped = await getLearnerCourseAssignment(s.learner.ctx, s.course.id);
      const [collectionFirst] = await getLearnerAssignments(s.learner.ctx);

      expect(scoped?.source).toBe(expected);
      expect(scoped).toEqual(collectionFirst);
    }
  );
});

describe("getLearnerCourseAssignment — parity with the collection read", () => {
  it("returns exactly what getLearnerAssignments returns for that course, across every status", async () => {
    const s = await createScenario();
    const now = new Date("2026-09-20T12:00:00.000Z");
    const started = await extraCourse(s);
    const overdue = await extraCourse(s);
    const completed = await extraCourse(s);
    const plain = await extraCourse(s);

    await assign(s, plain.course.id, { dueDate: new Date("2027-05-01T00:00:00.000Z") });
    await assign(s, started.course.id);
    await db.lessonProgress.create({
      data: { userId: s.learner.user.id, lessonId: started.lesson.id, isCompleted: true },
    });
    await assign(s, overdue.course.id, { dueDate: new Date("2026-01-01T00:00:00.000Z") });
    await assign(s, completed.course.id);
    await db.enrollment.update({
      where: { userId_courseId: { userId: s.learner.user.id, courseId: completed.course.id } },
      data: { status: "COMPLETED", completedAt: new Date() },
    });

    const all = await getLearnerAssignments(s.learner.ctx, now);

    expect(all.map((a) => a.status).sort()).toEqual([
      "ASSIGNED",
      "COMPLETED",
      "OVERDUE",
      "STARTED",
    ]);
    for (const expected of all) {
      expect(await getLearnerCourseAssignment(s.learner.ctx, expected.courseId, now)).toEqual(
        expected
      );
    }
  });
});

describe("getLearnerCourseAssignment — authorization", () => {
  it("rejects a non-student with 403, exactly like the collection read", async () => {
    const s = await createScenario();

    for (const actor of [s.admin.ctx, s.instructor.ctx]) {
      await expect(getLearnerCourseAssignment(actor, s.course.id)).rejects.toMatchObject({
        status: 403,
      });
      await expect(getLearnerCourseAssignment(actor, s.course.id)).rejects.toBeInstanceOf(
        AuthContextError
      );
    }
  });

  it("rejects a learner with no organisation with 400", async () => {
    const solo = await createTenantlessStudent();

    await expect(
      getLearnerCourseAssignment(
        { userId: solo.id, clerkId: solo.clerkId, tenantId: null, role: "STUDENT" },
        "any"
      )
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("getLearnerCourseAssignment — query efficiency", () => {
  async function measure(otherAssignments: number) {
    const s = await createScenario();
    await assign(s, s.course.id);
    for (let i = 0; i < otherAssignments; i++) {
      const c = await extraCourse(s);
      await assign(s, c.course.id);
    }
    const spies = {
      assignmentsFindMany: vi.spyOn(db.learningAssignment, "findMany"),
      enrollmentFindMany: vi.spyOn(db.enrollment, "findMany"),
      enrollmentFindUnique: vi.spyOn(db.enrollment, "findUnique"),
      courseFindMany: vi.spyOn(db.course, "findMany"),
      progressFindFirst: vi.spyOn(db.lessonProgress, "findFirst"),
      progressFindMany: vi.spyOn(db.lessonProgress, "findMany"),
    };
    const found = await getLearnerCourseAssignment(s.learner.ctx, s.course.id);
    const calls = Object.fromEntries(
      Object.entries(spies).map(([k, v]) => [k, v.mock.calls.length])
    );
    const assignmentWhere = spies.assignmentsFindMany.mock.calls[0]?.[0]?.where;
    vi.restoreAllMocks();
    return { found, calls, assignmentWhere, course: s.course };
  }

  it("puts the course in the database predicate instead of loading the collection and filtering", async () => {
    const { assignmentWhere, course } = await measure(3);

    expect(assignmentWhere).toMatchObject({ courseId: course.id, cancelledAt: null });
    expect(assignmentWhere).toHaveProperty("userId");
    expect(assignmentWhere).toHaveProperty("tenantId");
  });

  it("issues the same bounded set of queries with 0 or 12 assignments in other courses", async () => {
    const few = await measure(0);
    const many = await measure(12);

    expect(few.found).not.toBeNull();
    expect(many.found).not.toBeNull();
    expect(many.calls).toEqual(few.calls);
    expect(many.calls).toEqual({
      assignmentsFindMany: 1,
      enrollmentFindMany: 0,
      enrollmentFindUnique: 1,
      courseFindMany: 0,
      progressFindFirst: 1,
      progressFindMany: 0,
    });
  });

  it("never runs the collection read's enrollment, course or progress scans", async () => {
    const { calls } = await measure(5);

    expect(calls.enrollmentFindMany).toBe(0);
    expect(calls.courseFindMany).toBe(0);
    expect(calls.progressFindMany).toBe(0);
  });

  it("does no further lookups when the learner has no assignment for the course", async () => {
    const s = await createScenario();
    const enrollmentUnique = vi.spyOn(db.enrollment, "findUnique");
    const progress = vi.spyOn(db.lessonProgress, "findFirst");

    expect(await getLearnerCourseAssignment(s.learner.ctx, s.course.id)).toBeNull();

    expect(enrollmentUnique).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
  });
});
