import { afterAll, describe, expect, it, vi } from "vitest";
import { getCourseAssignmentContext } from "@/lib/course-assignment-context";
import { db } from "@/lib/db";
import {
  createCourseIn,
  createScenario,
  createTenantlessStudent,
  createUserIn,
} from "@/lib/domain/learning-assignment/__test__/fixtures";
import {
  cancelAssignment,
  createMandatoryAssignment,
  createManualAssignment,
} from "@/lib/domain/learning-assignment/assignments";

afterAll(async () => {
  await db.$disconnect();
});

async function assign(s: Awaited<ReturnType<typeof createScenario>>, courseId: string, extra = {}) {
  const result = await createManualAssignment(s.admin.ctx, {
    userId: s.learner.user.id,
    courseId,
    ...extra,
  });
  if (!result.ok) throw new Error(`setup failed: ${result.reason}`);
  return result.assignment;
}

describe("getCourseAssignmentContext", () => {
  it("returns the learner's assignment for the course, in the parsed card shape", async () => {
    const s = await createScenario();
    await assign(s, s.course.id, { dueDate: new Date("2027-03-01T23:59:59.999Z"), note: "hi" });

    const found = await getCourseAssignmentContext(s.learner.ctx, s.course.id);

    expect(found).toEqual({
      id: expect.any(String),
      courseSlug: s.course.slug,
      courseTitle: s.course.title,
      source: "MANUAL",
      reason: { kind: "MANUAL", assignedByName: s.admin.user.name, note: "hi" },
      dueDate: "2027-03-01T23:59:59.999Z",
      status: "ASSIGNED",
    });
  });

  it("returns null when the learner has no assignment for this course", async () => {
    const s = await createScenario();
    const other = await createCourseIn(s.tenant.id, s.instructor.user.id);
    await assign(s, other.course.id);

    expect(await getCourseAssignmentContext(s.learner.ctx, s.course.id)).toBeNull();
  });

  it("returns null once the assignment is cancelled", async () => {
    const s = await createScenario();
    const assignment = await assign(s, s.course.id);
    await cancelAssignment(s.admin.ctx, assignment.id);

    expect(await getCourseAssignmentContext(s.learner.ctx, s.course.id)).toBeNull();
  });

  it("does not show another learner's assignment", async () => {
    const s = await createScenario();
    const other = await createUserIn(s.tenant.id, "STUDENT");
    await assign(s, s.course.id);

    expect(await getCourseAssignmentContext(other.ctx, s.course.id)).toBeNull();
  });

  it("a malformed stored reason still yields a usable, neutral context", async () => {
    const s = await createScenario();
    const assignment = await assign(s, s.course.id);
    await db.learningAssignment.update({
      where: { id: assignment.id },
      data: { reason: "not an object" },
    });

    const found = await getCourseAssignmentContext(s.learner.ctx, s.course.id);

    expect(found).toMatchObject({
      courseSlug: s.course.slug,
      status: "ASSIGNED",
      reason: { kind: "MANUAL", assignedByName: null, note: null },
    });
  });

  it("returns null for roles that cannot hold assignments, without throwing", async () => {
    const s = await createScenario();
    await assign(s, s.course.id);

    for (const viewer of [s.admin.ctx, s.instructor.ctx]) {
      expect(await getCourseAssignmentContext(viewer, s.course.id), viewer.role).toBeNull();
    }
  });

  it("returns null for a learner with no organisation, without a database read", async () => {
    const solo = await createTenantlessStudent();
    const spy = vi.spyOn(db.learningAssignment, "findMany");

    const found = await getCourseAssignmentContext(
      { userId: solo.id, clerkId: solo.clerkId, tenantId: null, role: "STUDENT" },
      "any-course"
    );

    expect(found).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("returns null instead of throwing when the read fails, so a course page still renders", async () => {
    const s = await createScenario();
    await assign(s, s.course.id);
    const spy = vi
      .spyOn(db.learningAssignment, "findMany")
      .mockRejectedValueOnce(new Error("connection reset"));

    await expect(getCourseAssignmentContext(s.learner.ctx, s.course.id)).resolves.toBeNull();
    spy.mockRestore();
  });

  it("asks the database for this course only: the predicate carries the course and no collection scans run", async () => {
    const s = await createScenario();
    const other = await createCourseIn(s.tenant.id, s.instructor.user.id);
    await assign(s, s.course.id);
    await assign(s, other.course.id);
    const assignments = vi.spyOn(db.learningAssignment, "findMany");
    const enrollmentScan = vi.spyOn(db.enrollment, "findMany");
    const courseScan = vi.spyOn(db.course, "findMany");

    const found = await getCourseAssignmentContext(s.learner.ctx, s.course.id);

    expect(found?.courseSlug).toBe(s.course.slug);
    expect(assignments).toHaveBeenCalledTimes(1);
    expect(assignments.mock.calls[0][0]?.where).toMatchObject({ courseId: s.course.id });
    expect(enrollmentScan).not.toHaveBeenCalled();
    expect(courseScan).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("when a course has two assignments, returns the one due first, the same one every time", async () => {
    const s = await createScenario();
    const team = await db.team.create({ data: { name: "t", tenantId: s.tenant.id } });
    await db.teamMember.create({ data: { teamId: team.id, userId: s.learner.user.id } });
    const training = await db.mandatoryTraining.create({
      data: {
        tenantId: s.tenant.id,
        courseId: s.course.id,
        teamId: team.id,
        dueDate: new Date("2098-01-01T00:00:00.000Z"),
      },
    });
    await assign(s, s.course.id, { dueDate: new Date("2099-01-01T00:00:00.000Z") });
    const mandatory = await createMandatoryAssignment(s.admin.ctx, {
      userId: s.learner.user.id,
      mandatoryTrainingId: training.id,
    });
    expect(mandatory.ok).toBe(true);

    const first = await getCourseAssignmentContext(s.learner.ctx, s.course.id);
    const second = await getCourseAssignmentContext(s.learner.ctx, s.course.id);

    expect(first?.source).toBe("MANDATORY");
    expect(first?.dueDate).toBe("2098-01-01T00:00:00.000Z");
    expect(second).toEqual(first);
  });
});
