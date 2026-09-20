import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  createCourseIn,
  createScenario,
  createTenant,
  createUserIn,
} from "@/lib/domain/learning-assignment/__test__/fixtures";
import {
  cancelAssignment,
  createCapabilityGapAssignment,
  createMandatoryAssignment,
  createManualAssignment,
} from "@/lib/domain/learning-assignment/assignments";

afterAll(async () => {
  await db.$disconnect();
});

const NOT_FOUND = { ok: false, reason: "COURSE_NOT_FOUND" } as const;

async function expectNothingWritten(userId: string) {
  expect(await db.learningAssignment.count({ where: { userId } })).toBe(0);
  expect(await db.enrollment.count({ where: { userId } })).toBe(0);
  expect(await db.notification.count({ where: { userId } })).toBe(0);
}

describe("L-1 — a course outside the actor's tenant discloses nothing", () => {
  async function inaccessibleCourses() {
    const scenario = await createScenario();
    const { tenant, instructor } = scenario;
    const other = await createTenant();
    const otherInstructor = await createUserIn(other.id, "INSTRUCTOR");

    const foreignPublished = await createCourseIn(other.id, otherInstructor.user.id);
    const foreignDraft = await createCourseIn(other.id, otherInstructor.user.id, {
      status: "DRAFT",
    });
    const foreignPaid = await createCourseIn(other.id, otherInstructor.user.id, { price: 999 });
    // The open catalogue (no tenant) is enrollable by anyone when published and
    // free, so the tenant predicate lets it through. Its draft, archived and
    // paid forms must still be indistinguishable from a course that is absent.
    const catalogueDraft = await createCourseIn(null, instructor.user.id, { status: "DRAFT" });
    const catalogueArchived = await createCourseIn(null, instructor.user.id, {
      status: "ARCHIVED",
    });
    const cataloguePaid = await createCourseIn(null, instructor.user.id, { price: 50 });

    return {
      ...scenario,
      tenantId: tenant.id,
      courseIds: {
        unknown: "does-not-exist",
        foreignPublished: foreignPublished.course.id,
        foreignDraft: foreignDraft.course.id,
        foreignPaid: foreignPaid.course.id,
        catalogueDraft: catalogueDraft.course.id,
        catalogueArchived: catalogueArchived.course.id,
        cataloguePaid: cataloguePaid.course.id,
      },
    };
  }

  it("answers COURSE_NOT_FOUND identically for unknown, foreign and open-catalogue non-assignable courses", async () => {
    const { admin, learner, courseIds } = await inaccessibleCourses();

    for (const [label, courseId] of Object.entries(courseIds)) {
      const result = await createManualAssignment(admin.ctx, {
        userId: learner.user.id,
        courseId,
      });
      expect(result, label).toEqual(NOT_FOUND);
    }
    await expectNothingWritten(learner.user.id);
  });

  it("applies the same rule through the mandatory-training path", async () => {
    const { tenant, admin, learner, instructor } = await createScenario();
    const { course: catalogueDraft } = await createCourseIn(null, instructor.user.id, {
      status: "DRAFT",
    });
    const team = await db.team.create({ data: { name: "t", tenantId: tenant.id } });
    await db.teamMember.create({ data: { teamId: team.id, userId: learner.user.id } });
    const training = await db.mandatoryTraining.create({
      data: {
        tenantId: tenant.id,
        courseId: catalogueDraft.id,
        teamId: team.id,
        dueDate: new Date("2027-01-15T23:59:59.999Z"),
      },
    });

    const result = await createMandatoryAssignment(admin.ctx, {
      userId: learner.user.id,
      mandatoryTrainingId: training.id,
    });

    expect(result).toEqual(NOT_FOUND);
    await expectNothingWritten(learner.user.id);
  });

  it("still reports the specific reason for the actor's OWN tenant's courses", async () => {
    const { tenant, admin, learner, instructor } = await createScenario();
    const draft = await createCourseIn(tenant.id, instructor.user.id, { status: "DRAFT" });
    const archived = await createCourseIn(tenant.id, instructor.user.id, { status: "ARCHIVED" });
    const paid = await createCourseIn(tenant.id, instructor.user.id, { price: 499 });

    const results = await Promise.all(
      [draft, archived, paid].map(({ course }) =>
        createManualAssignment(admin.ctx, { userId: learner.user.id, courseId: course.id })
      )
    );

    expect(results).toEqual([
      { ok: false, reason: "COURSE_NOT_PUBLISHED" },
      { ok: false, reason: "COURSE_NOT_PUBLISHED" },
      { ok: false, reason: "COURSE_REQUIRES_PAYMENT" },
    ]);
    await expectNothingWritten(learner.user.id);
  });

  it("still assigns a published, free open-catalogue course", async () => {
    const { admin, learner, instructor } = await createScenario();
    const { course } = await createCourseIn(null, instructor.user.id);

    const result = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
    });

    expect(result.ok).toBe(true);
  });
});

describe("L-3 — untrusted values are rejected as INVALID_INPUT, never as a driver error", () => {
  const BAD_IDS = ["", "a b", "a\u0000b", "a'b", "x".repeat(200), "a\nb"];

  it("rejects malformed learner and course ids on the manual path", async () => {
    const { admin, learner, course } = await createScenario();

    for (const bad of BAD_IDS) {
      expect(
        await createManualAssignment(admin.ctx, { userId: bad, courseId: course.id }),
        `userId ${JSON.stringify(bad)}`
      ).toEqual({ ok: false, reason: "INVALID_INPUT" });
      expect(
        await createManualAssignment(admin.ctx, { userId: learner.user.id, courseId: bad }),
        `courseId ${JSON.stringify(bad)}`
      ).toEqual({ ok: false, reason: "INVALID_INPUT" });
    }
    await expectNothingWritten(learner.user.id);
  });

  it("rejects malformed ids on the mandatory and capability-gap paths", async () => {
    const { admin, learner, course } = await createScenario();

    for (const bad of BAD_IDS) {
      expect(
        await createMandatoryAssignment(admin.ctx, {
          userId: learner.user.id,
          mandatoryTrainingId: bad,
        })
      ).toEqual({ ok: false, reason: "INVALID_INPUT" });
      expect(
        await createCapabilityGapAssignment(admin.ctx, {
          userId: learner.user.id,
          roleId: bad,
          skillId: "s",
          courseId: course.id,
        })
      ).toEqual({ ok: false, reason: "INVALID_INPUT" });
      expect(
        await createCapabilityGapAssignment(admin.ctx, {
          userId: learner.user.id,
          roleId: "r",
          skillId: bad,
          courseId: course.id,
        })
      ).toEqual({ ok: false, reason: "INVALID_INPUT" });
    }
    await expectNothingWritten(learner.user.id);
  });

  it("rejects an assignment id that is malformed on cancel", async () => {
    const { admin } = await createScenario();

    for (const bad of BAD_IDS) {
      expect(await cancelAssignment(admin.ctx, bad)).toEqual({
        ok: false,
        reason: "ASSIGNMENT_NOT_FOUND",
      });
    }
  });

  it("rejects due dates a database cannot store, with nothing left behind", async () => {
    const { admin, learner, course } = await createScenario();

    for (const dueDate of [
      new Date("invalid"),
      new Date(-8.64e15),
      new Date(8.64e15),
      new Date("2101-01-01T00:00:00.000Z"),
      new Date("1969-12-31T00:00:00.000Z"),
    ]) {
      expect(
        await createManualAssignment(admin.ctx, {
          userId: learner.user.id,
          courseId: course.id,
          dueDate,
        })
      ).toEqual({ ok: false, reason: "INVALID_INPUT" });
    }
    await expectNothingWritten(learner.user.id);
  });

  it("rejects a non-Date due date (for example an unparsed string)", async () => {
    const { admin, learner, course } = await createScenario();

    const result = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
      dueDate: "2027-01-01" as never,
    });

    expect(result).toEqual({ ok: false, reason: "INVALID_INPUT" });
    await expectNothingWritten(learner.user.id);
  });

  it("rejects notes with NUL, other control characters or lone surrogates, and over-long notes", async () => {
    const { admin, learner, course } = await createScenario();

    for (const note of ["a\u0000b", "a\u0007b", "a\u001Bb", "a\uD800b", "x".repeat(501)]) {
      expect(
        await createManualAssignment(admin.ctx, {
          userId: learner.user.id,
          courseId: course.id,
          note,
        }),
        JSON.stringify(note).slice(0, 20)
      ).toEqual({ ok: false, reason: "INVALID_INPUT" });
    }
    await expectNothingWritten(learner.user.id);
  });

  it("accepts a multi-line note and a note of exactly the maximum length", async () => {
    const { tenant, admin, learner, course } = await createScenario();
    const second = await createUserIn(tenant.id, "STUDENT");

    const multiline = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
      note: "line one\nline two\ttabbed",
    });
    const atLimit = await createManualAssignment(admin.ctx, {
      userId: second.user.id,
      courseId: course.id,
      note: "x".repeat(500),
    });

    expect(multiline.ok).toBe(true);
    expect(atLimit.ok).toBe(true);
    expect(multiline.ok && multiline.assignment.reason).toMatchObject({
      note: "line one\nline two\ttabbed",
    });
  });

  it("rejects missing or non-object input instead of throwing a TypeError", async () => {
    const { admin, course } = await createScenario();

    for (const input of [undefined, null, "x", 5, {}, { courseId: course.id }]) {
      expect(await createManualAssignment(admin.ctx, input as never)).toEqual({
        ok: false,
        reason: "INVALID_INPUT",
      });
    }
    expect(await createMandatoryAssignment(admin.ctx, undefined as never)).toEqual({
      ok: false,
      reason: "INVALID_INPUT",
    });
    expect(await createCapabilityGapAssignment(admin.ctx, null as never)).toEqual({
      ok: false,
      reason: "INVALID_INPUT",
    });
  });

  it("still allows a past due date: the assignment is created and derives OVERDUE (L-4 is unchanged)", async () => {
    const { admin, learner, course } = await createScenario();

    const result = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
      dueDate: new Date("2020-01-01T00:00:00.000Z"),
    });

    expect(result.ok && result.status).toBe("OVERDUE");
  });

  it("derives identity from the authenticated actor: forged tenantId and assignedById are ignored", async () => {
    const { tenant, admin, learner, course } = await createScenario();
    const other = await createTenant();
    const intruder = await createUserIn(other.id, "ORG_ADMIN");

    const result = await createManualAssignment(admin.ctx, {
      userId: learner.user.id,
      courseId: course.id,
      tenantId: other.id,
      assignedById: intruder.user.id,
    } as never);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assignment.tenantId).toBe(tenant.id);
    expect(result.assignment.assignedById).toBe(admin.user.id);
  });
});
