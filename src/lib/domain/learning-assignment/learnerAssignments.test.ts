import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  addSkillToRole,
  assignRole,
  createCourseIn,
  createMandatoryTraining,
  createRoleWithSkill,
  createScenario,
  createTeamWithMember,
  createTenant,
  createUserIn,
  mapCourseToSkill,
  setUserSkill,
} from "@/lib/domain/learning-assignment/__test__/fixtures";
import {
  cancelAssignment,
  createCapabilityGapAssignment,
  createMandatoryAssignment,
  createManualAssignment,
} from "@/lib/domain/learning-assignment/assignments";
import { getLearnerAssignments } from "@/lib/domain/learning-assignment/learnerAssignments";

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

async function assign(
  scenario: Awaited<ReturnType<typeof createScenario>>,
  courseId: string,
  extra: { dueDate?: Date | null; note?: string; learnerId?: string } = {}
) {
  const result = await createManualAssignment(scenario.admin.ctx, {
    userId: extra.learnerId ?? scenario.learner.user.id,
    courseId,
    ...(extra.dueDate !== undefined ? { dueDate: extra.dueDate } : {}),
    ...(extra.note !== undefined ? { note: extra.note } : {}),
  });
  if (!result.ok) throw new Error(`setup failed: ${result.reason}`);
  return result.assignment;
}

describe("getLearnerAssignments — shape and content", () => {
  it("returns the learner's own assignment with exactly the learner-facing fields", async () => {
    const s = await createScenario();
    const due = new Date("2027-03-01T23:59:59.999Z");
    const assignment = await assign(s, s.course.id, { dueDate: due });

    const result = await getLearnerAssignments(s.learner.ctx);

    expect(result).toEqual([
      {
        id: assignment.id,
        courseId: s.course.id,
        courseTitle: s.course.title,
        courseSlug: s.course.slug,
        source: "MANUAL",
        reason: { assignedByName: s.admin.user.name },
        dueDate: due,
        status: "ASSIGNED",
        createdAt: assignment.createdAt,
      },
    ]);
  });

  it("never exposes administrative or tenant identifiers", async () => {
    const s = await createScenario();
    await assign(s, s.course.id, { note: "Please finish this." });

    const [row] = await getLearnerAssignments(s.learner.ctx);
    const serialised = JSON.stringify(row);

    for (const forbidden of [
      "assignedById",
      "cancelledById",
      "cancelledAt",
      "tenantId",
      "userId",
      "mandatoryTrainingId",
      "sourceKey",
      s.admin.user.id,
      s.tenant.id,
    ]) {
      expect(serialised, forbidden).not.toContain(forbidden);
    }
  });

  it("returns a null due date as null", async () => {
    const s = await createScenario();
    await assign(s, s.course.id);

    const [row] = await getLearnerAssignments(s.learner.ctx);

    expect(row.dueDate).toBeNull();
  });

  it("returns several assignments, including two sources for the same course", async () => {
    const s = await createScenario();
    const { course: second } = await createCourseIn(s.tenant.id, s.instructor.user.id);
    const team = await createTeamWithMember(s.tenant.id, s.learner.user.id);
    const training = await createMandatoryTraining({
      tenantId: s.tenant.id,
      courseId: s.course.id,
      teamId: team.id,
    });
    await assign(s, s.course.id);
    await assign(s, second.id);
    await createMandatoryAssignment(s.admin.ctx, {
      userId: s.learner.user.id,
      mandatoryTrainingId: training.id,
    });

    const result = await getLearnerAssignments(s.learner.ctx);

    expect(result).toHaveLength(3);
    expect(
      result
        .filter((r) => r.courseId === s.course.id)
        .map((r) => r.source)
        .sort()
    ).toEqual(["MANDATORY", "MANUAL"]);
  });

  it("returns an empty list when the learner has no assignments", async () => {
    const s = await createScenario();

    expect(await getLearnerAssignments(s.learner.ctx)).toEqual([]);
  });
});

describe("getLearnerAssignments — learner-facing reason", () => {
  it("MANUAL: the assigner's name and the note, but not the assigner's id", async () => {
    const s = await createScenario();
    await assign(s, s.course.id, { note: "Finish before the audit." });

    const [row] = await getLearnerAssignments(s.learner.ctx);

    expect(row.source).toBe("MANUAL");
    expect(row.reason).toEqual({
      assignedByName: s.admin.user.name,
      note: "Finish before the audit.",
    });
  });

  it("MANDATORY: the team name only", async () => {
    const s = await createScenario();
    const team = await createTeamWithMember(s.tenant.id, s.learner.user.id);
    const training = await createMandatoryTraining({
      tenantId: s.tenant.id,
      courseId: s.course.id,
      teamId: team.id,
    });
    await createMandatoryAssignment(s.admin.ctx, {
      userId: s.learner.user.id,
      mandatoryTrainingId: training.id,
    });

    const [row] = await getLearnerAssignments(s.learner.ctx);

    expect(row.source).toBe("MANDATORY");
    expect(row.reason).toEqual({ teamName: team.name });
  });

  it("CAPABILITY_GAP: role, skill and proficiencies, without internal ids", async () => {
    const s = await createScenario();
    const { role, skill } = await createRoleWithSkill({
      tenantId: s.tenant.id,
      requiredProficiency: "INTERMEDIATE",
    });
    await assignRole(s.tenant.id, s.learner.user.id, role.id);
    await setUserSkill(s.tenant.id, s.learner.user.id, skill.id, "BEGINNER");
    await mapCourseToSkill(s.course.id, skill.id);
    await createCapabilityGapAssignment(s.admin.ctx, {
      userId: s.learner.user.id,
      roleId: role.id,
      skillId: skill.id,
      courseId: s.course.id,
    });

    const [row] = await getLearnerAssignments(s.learner.ctx);

    expect(row.source).toBe("CAPABILITY_GAP");
    expect(row.reason).toEqual({
      roleName: role.name,
      skillName: skill.name,
      requiredProficiency: "INTERMEDIATE",
      currentProficiency: "BEGINNER",
    });
    const serialised = JSON.stringify(row);
    for (const id of [role.id, skill.id]) expect(serialised).not.toContain(id);
  });

  it("returns a null reason, not a throw, when a stored snapshot is malformed", async () => {
    const s = await createScenario();
    const assignment = await assign(s, s.course.id);
    await db.learningAssignment.update({
      where: { id: assignment.id },
      data: { reason: { unexpected: true } },
    });

    const [row] = await getLearnerAssignments(s.learner.ctx);

    expect(row.reason).toBeNull();
  });
});

describe("getLearnerAssignments — derived status", () => {
  it("ASSIGNED, STARTED, OVERDUE and COMPLETED are derived from real enrollment and progress", async () => {
    const s = await createScenario();
    const started = await createCourseIn(s.tenant.id, s.instructor.user.id);
    const overdue = await createCourseIn(s.tenant.id, s.instructor.user.id);
    const done = await createCourseIn(s.tenant.id, s.instructor.user.id);
    const future = new Date("2099-01-01T00:00:00.000Z");
    const past = new Date("2020-01-01T00:00:00.000Z");

    const a = await assign(s, s.course.id, { dueDate: future });
    const b = await assign(s, started.course.id, { dueDate: future });
    const c = await assign(s, overdue.course.id, { dueDate: past });
    const d = await assign(s, done.course.id, { dueDate: past });
    await db.lessonProgress.create({
      data: { userId: s.learner.user.id, lessonId: started.lesson.id },
    });
    await db.enrollment.update({
      where: { userId_courseId: { userId: s.learner.user.id, courseId: done.course.id } },
      data: { status: "COMPLETED", completedAt: new Date() },
    });

    const result = await getLearnerAssignments(s.learner.ctx);
    const statusOf = (id: string) => result.find((r) => r.id === id)?.status;

    expect(statusOf(a.id)).toBe("ASSIGNED");
    expect(statusOf(b.id)).toBe("STARTED");
    expect(statusOf(c.id)).toBe("OVERDUE");
    expect(statusOf(d.id)).toBe("COMPLETED");
  });

  it("uses the supplied clock, so the result is deterministic", async () => {
    const s = await createScenario();
    const due = new Date("2027-06-01T00:00:00.000Z");
    await assign(s, s.course.id, { dueDate: due });

    const before = await getLearnerAssignments(s.learner.ctx, new Date("2027-05-31T00:00:00.000Z"));
    const after = await getLearnerAssignments(s.learner.ctx, new Date("2027-06-02T00:00:00.000Z"));

    expect(before[0].status).toBe("ASSIGNED");
    expect(after[0].status).toBe("OVERDUE");
  });

  it("does not let another learner's progress or enrollment change this learner's status", async () => {
    const s = await createScenario();
    const other = await createUserIn(s.tenant.id, "STUDENT");
    await assign(s, s.course.id);
    await assign(s, s.course.id, { learnerId: other.user.id });
    await db.lessonProgress.create({ data: { userId: other.user.id, lessonId: s.lesson.id } });
    await db.enrollment.update({
      where: { userId_courseId: { userId: other.user.id, courseId: s.course.id } },
      data: { status: "COMPLETED", completedAt: new Date() },
    });

    const mine = await getLearnerAssignments(s.learner.ctx);
    const theirs = await getLearnerAssignments(other.ctx);

    expect(mine.map((r) => r.status)).toEqual(["ASSIGNED"]);
    expect(theirs.map((r) => r.status)).toEqual(["COMPLETED"]);
  });

  it("does not derive STARTED from progress on a different course", async () => {
    const s = await createScenario();
    const { lesson: otherLesson } = await createCourseIn(s.tenant.id, s.instructor.user.id);
    await assign(s, s.course.id);
    await db.lessonProgress.create({
      data: { userId: s.learner.user.id, lessonId: otherLesson.id },
    });

    const [row] = await getLearnerAssignments(s.learner.ctx);

    expect(row.status).toBe("ASSIGNED");
  });
});

describe("getLearnerAssignments — cancelled history", () => {
  it("does not return a cancelled assignment (Phase 28A §19: non-cancelled only), and returns it again once reactivated", async () => {
    const s = await createScenario();
    const assignment = await assign(s, s.course.id);
    await cancelAssignment(s.admin.ctx, assignment.id);

    expect(await getLearnerAssignments(s.learner.ctx)).toEqual([]);
    expect(await db.learningAssignment.count({ where: { id: assignment.id } })).toBe(1);

    await assign(s, s.course.id);

    const result = await getLearnerAssignments(s.learner.ctx);
    expect(result.map((r) => r.id)).toEqual([assignment.id]);
    expect(result[0].status).toBe("ASSIGNED");
  });

  it("never reports the CANCELLED status", async () => {
    const s = await createScenario();
    const a = await assign(s, s.course.id);
    const { course: second } = await createCourseIn(s.tenant.id, s.instructor.user.id);
    await assign(s, second.id);
    await cancelAssignment(s.admin.ctx, a.id);

    const result = await getLearnerAssignments(s.learner.ctx);

    expect(result.map((r) => r.status)).not.toContain("CANCELLED");
    expect(result).toHaveLength(1);
  });
});

describe("getLearnerAssignments — isolation", () => {
  it("returns only the caller's assignments, never another learner's", async () => {
    const s = await createScenario();
    const other = await createUserIn(s.tenant.id, "STUDENT");
    const mine = await assign(s, s.course.id);
    const theirs = await assign(s, s.course.id, { learnerId: other.user.id });

    const result = await getLearnerAssignments(s.learner.ctx);

    expect(result.map((r) => r.id)).toEqual([mine.id]);
    expect(result.map((r) => r.id)).not.toContain(theirs.id);
  });

  it("Tenant A's learner cannot see Tenant B's assignment, even though the ids are known", async () => {
    const a = await createScenario();
    const b = await createScenario();
    const bAssignment = await assign(b, b.course.id);

    const asA = await getLearnerAssignments(a.learner.ctx);
    // Even a caller who presents Tenant B's learner id with Tenant A's tenant
    // gets nothing: both userId and tenantId scope the query.
    const forged = await getLearnerAssignments({
      ...b.learner.ctx,
      tenantId: a.tenant.id,
    });

    expect(asA).toEqual([]);
    expect(forged).toEqual([]);
    expect(await getLearnerAssignments(b.learner.ctx)).toHaveLength(1);
    expect(bAssignment.tenantId).toBe(b.tenant.id);
  });

  it("hides an assignment row that belongs to a previous tenant of the same learner", async () => {
    const s = await createScenario();
    const otherTenant = await createTenant();
    await db.learningAssignment.create({
      data: {
        tenantId: otherTenant.id,
        userId: s.learner.user.id,
        courseId: s.course.id,
        source: "MANUAL",
        sourceKey: `manual:${s.course.id}`,
        reason: { assignedById: "x", assignedByName: "Old admin" },
      },
    });

    expect(await getLearnerAssignments(s.learner.ctx)).toEqual([]);
  });

  it("returns nothing for a deleted learner", async () => {
    const s = await createScenario();
    await assign(s, s.course.id);
    await db.user.update({ where: { id: s.learner.user.id }, data: { deletedAt: new Date() } });

    expect(await getLearnerAssignments(s.learner.ctx)).toEqual([]);
  });

  it("rejects a non-student with 403 and a caller without a tenant with 400", async () => {
    const s = await createScenario();
    await assign(s, s.course.id);

    for (const actor of [s.admin, s.instructor]) {
      await expect(getLearnerAssignments(actor.ctx)).rejects.toMatchObject({
        name: "AuthContextError",
        status: 403,
      });
    }
    await expect(getLearnerAssignments({ ...s.learner.ctx, tenantId: null })).rejects.toMatchObject(
      { name: "AuthContextError", status: 400 }
    );
  });
});

describe("getLearnerAssignments — ordering", () => {
  it("puts open assignments before completed ones, then by due date (none last), created time, then id", async () => {
    const s = await createScenario();
    const courses = await Promise.all(
      Array.from({ length: 6 }, () => createCourseIn(s.tenant.id, s.instructor.user.id))
    );
    const [noDueOld, dueLate, dueSoon, overdue, completed, noDueNew] = courses.map((c) => c.course);
    const a = {
      noDueOld: await assign(s, noDueOld.id),
      dueLate: await assign(s, dueLate.id, { dueDate: new Date("2099-06-01T00:00:00.000Z") }),
      dueSoon: await assign(s, dueSoon.id, { dueDate: new Date("2098-01-01T00:00:00.000Z") }),
      overdue: await assign(s, overdue.id, { dueDate: new Date("2020-01-01T00:00:00.000Z") }),
      completed: await assign(s, completed.id, { dueDate: new Date("2019-01-01T00:00:00.000Z") }),
      noDueNew: await assign(s, noDueNew.id),
    };
    await db.enrollment.update({
      where: { userId_courseId: { userId: s.learner.user.id, courseId: completed.id } },
      data: { status: "COMPLETED", completedAt: new Date() },
    });

    const result = await getLearnerAssignments(s.learner.ctx);

    expect(result.map((r) => r.id)).toEqual([
      a.overdue.id,
      a.dueSoon.id,
      a.dueLate.id,
      a.noDueOld.id,
      a.noDueNew.id,
      a.completed.id,
    ]);
  });

  it("orders ties by created time and then id, independent of how the rows happen to be stored", async () => {
    const s = await createScenario();
    const courses = await Promise.all(
      Array.from({ length: 4 }, () => createCourseIn(s.tenant.id, s.instructor.user.id))
    );
    const t1 = new Date("2026-01-01T00:00:00.000Z");
    const t2 = new Date("2026-02-01T00:00:00.000Z");
    const t3 = new Date("2026-03-01T00:00:00.000Z");
    // Inserted in an order that contradicts the expected order on both keys, so
    // neither "insertion order" nor "id order" alone can produce the result.
    const rows = [
      { id: "asg-c", createdAt: t2 },
      { id: "asg-a", createdAt: t2 },
      { id: "asg-b", createdAt: t1 },
      { id: "asg-d", createdAt: t3 },
    ];
    for (const [i, row] of rows.entries()) {
      await db.learningAssignment.create({
        data: {
          id: `${row.id}-${s.learner.user.id}`,
          tenantId: s.tenant.id,
          userId: s.learner.user.id,
          courseId: courses[i].course.id,
          source: "MANUAL",
          sourceKey: `manual:${courses[i].course.id}`,
          reason: { assignedByName: null },
          createdAt: row.createdAt,
        },
      });
    }

    const first = await getLearnerAssignments(s.learner.ctx);
    const second = await getLearnerAssignments(s.learner.ctx);

    const suffix = `-${s.learner.user.id}`;
    expect(first.map((r) => r.id.replace(suffix, ""))).toEqual([
      "asg-b",
      "asg-a",
      "asg-c",
      "asg-d",
    ]);
    expect(second.map((r) => r.id)).toEqual(first.map((r) => r.id));
  });
});

describe("getLearnerAssignments — query efficiency", () => {
  async function countQueries(assignmentCount: number) {
    const s = await createScenario();
    for (let i = 0; i < assignmentCount; i++) {
      const { course, lesson } = await createCourseIn(s.tenant.id, s.instructor.user.id);
      await assign(s, course.id);
      if (i % 2 === 0) {
        await db.lessonProgress.create({
          data: { userId: s.learner.user.id, lessonId: lesson.id },
        });
      }
    }
    const spies = {
      assignments: vi.spyOn(db.learningAssignment, "findMany"),
      enrollments: vi.spyOn(db.enrollment, "findMany"),
      courses: vi.spyOn(db.course, "findMany"),
      progress: vi.spyOn(db.lessonProgress, "findMany"),
      progressFirst: vi.spyOn(db.lessonProgress, "findFirst"),
      enrollmentFirst: vi.spyOn(db.enrollment, "findFirst"),
      courseUnique: vi.spyOn(db.course, "findUnique"),
    };
    const result = await getLearnerAssignments(s.learner.ctx);
    const calls = Object.fromEntries(
      Object.entries(spies).map(([k, v]) => [k, v.mock.calls.length])
    );
    vi.restoreAllMocks();
    return { calls, count: result.length };
  }

  it("issues the same fixed number of queries for 1 assignment as for 12", async () => {
    const small = await countQueries(1);
    const large = await countQueries(12);

    expect(small.count).toBe(1);
    expect(large.count).toBe(12);
    expect(large.calls).toEqual(small.calls);
    // One query for the assignments (with their course), one for enrollments,
    // one for which of those courses have progress — and no per-row lookups.
    const total = Object.values(large.calls).reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(3);
  });

  it("skips the enrollment and progress lookups entirely when there is nothing to derive", async () => {
    const s = await createScenario();
    const enrollments = vi.spyOn(db.enrollment, "findMany");

    await getLearnerAssignments(s.learner.ctx);

    expect(enrollments).not.toHaveBeenCalled();
  });
});

describe("getLearnerAssignments — gap assignment sanity", () => {
  it("keeps two skill-gap assignments for one course as two rows", async () => {
    const s = await createScenario();
    const { role, skill } = await createRoleWithSkill({ tenantId: s.tenant.id });
    // BEGINNER, not ADVANCED: this test is about two skills producing two
    // rows, not about the required level — Phase 30's G1 guard skips
    // creation for a required level the capability policy can never grant.
    const secondSkill = await addSkillToRole(role.id, s.tenant.id, "BEGINNER");
    await assignRole(s.tenant.id, s.learner.user.id, role.id);
    await mapCourseToSkill(s.course.id, skill.id);
    await mapCourseToSkill(s.course.id, secondSkill.id);
    for (const skillId of [skill.id, secondSkill.id]) {
      await createCapabilityGapAssignment(s.admin.ctx, {
        userId: s.learner.user.id,
        roleId: role.id,
        skillId,
        courseId: s.course.id,
      });
    }

    const result = await getLearnerAssignments(s.learner.ctx);

    expect(result).toHaveLength(2);
    expect(new Set(result.map((r) => (r.reason as { skillName: string }).skillName)).size).toBe(2);
  });
});
