import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  createCourse,
  createQuiz,
  createQuizAttempt,
  createSkill,
  mapCourseSkill,
} from "@/lib/domain/capability/__test__/fixtures";
import { addCourseSkill } from "@/lib/domain/capability/courseSkillManagement";
import {
  CourseCompletionEvidenceError,
  recordCourseCompletionOutcome,
  recordQuizOutcome,
} from "@/lib/domain/capability/outcomes";
import {
  reconcileCompletedLearnersForCourseSkill,
  reconcileCourseCompletionEvidence,
} from "@/lib/domain/capability/reconciliation";
import { rejectEvidence, verifyEvidence } from "@/lib/domain/capability/verification";
import { createUserInTenant } from "@/lib/domain/course/__test__/fixtures";
import { createTenantUser } from "@/lib/domain/knowledge/__test__/fixtures";

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

function enrollment(userId: string, courseId: string, status: "ACTIVE" | "COMPLETED" | "REFUNDED") {
  return db.enrollment.create({
    data: {
      userId,
      courseId,
      status,
      completedAt: status === "COMPLETED" ? new Date() : null,
    },
  });
}

const evidenceFor = (userId: string, skillId: string) =>
  db.skillEvidence.findMany({ where: { userId, skillId } });

async function setup() {
  const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
  const { course } = await createCourse(tenant.id, instructorCtx.userId);
  const skill = await createSkill(tenant.id);
  const learner = await createUserInTenant(tenant.id, "STUDENT");
  return { tenant, instructorCtx, course, skill, learner };
}

describe("reconcileCourseCompletionEvidence — eligibility and boundaries", () => {
  it("creates the missing COURSE_COMPLETION evidence for a COMPLETED enrollment, dated at completion", async () => {
    const { tenant, course, skill, learner } = await setup();
    await mapCourseSkill(course.id, skill.id);
    const completed = await enrollment(learner.id, course.id, "COMPLETED");

    const result = await reconcileCourseCompletionEvidence({
      tenantId: tenant.id,
      userId: learner.id,
      courseId: course.id,
    });

    expect(result).toEqual({ created: 1, alreadyPresent: 0, skipped: null });
    const [row] = await evidenceFor(learner.id, skill.id);
    expect(row.type).toBe("COURSE_COMPLETION");
    expect(row.sourceType).toBe("Course");
    expect(row.sourceId).toBe(course.id);
    expect(row.verificationStatus).toBe("UNVERIFIED");
    const userSkill = await db.userSkill.findUnique({
      where: { userId_skillId: { userId: learner.id, skillId: skill.id } },
    });
    expect(userSkill?.proficiency).toBe("BEGINNER");
    expect(userSkill?.lastAssessedAt?.getTime()).toBe(completed.completedAt?.getTime());
  });

  it.each(["ACTIVE", "REFUNDED"] as const)(
    "never creates evidence for a %s enrollment",
    async (status) => {
      const { tenant, course, skill, learner } = await setup();
      await mapCourseSkill(course.id, skill.id);
      await enrollment(learner.id, course.id, status);

      const result = await reconcileCourseCompletionEvidence({
        tenantId: tenant.id,
        userId: learner.id,
        courseId: course.id,
      });

      expect(result.skipped).toBe("not-completed");
      expect(await evidenceFor(learner.id, skill.id)).toHaveLength(0);
    }
  );

  it("never creates evidence when the user has no enrollment", async () => {
    const { tenant, course, skill, learner } = await setup();
    await mapCourseSkill(course.id, skill.id);

    const result = await reconcileCourseCompletionEvidence({
      tenantId: tenant.id,
      userId: learner.id,
      courseId: course.id,
    });

    expect(result.skipped).toBe("not-completed");
    expect(await evidenceFor(learner.id, skill.id)).toHaveLength(0);
  });

  it("creates nothing when the course has no CourseSkill mappings", async () => {
    const { tenant, course, learner } = await setup();
    await enrollment(learner.id, course.id, "COMPLETED");

    const result = await reconcileCourseCompletionEvidence({
      tenantId: tenant.id,
      userId: learner.id,
      courseId: course.id,
    });

    expect(result).toEqual({ created: 0, alreadyPresent: 0, skipped: null });
  });

  it("refuses a tenant that does not own the course — no cross-tenant evidence", async () => {
    const { course, skill, learner } = await setup();
    const { tenant: otherTenant } = await createTenantUser();
    await mapCourseSkill(course.id, skill.id);
    await enrollment(learner.id, course.id, "COMPLETED");

    const result = await reconcileCourseCompletionEvidence({
      tenantId: otherTenant.id,
      userId: learner.id,
      courseId: course.id,
    });

    expect(result.skipped).toBe("tenant-mismatch");
    expect(await db.skillEvidence.count({ where: { userId: learner.id } })).toBe(0);
  });

  it("refuses a learner who belongs to a different tenant than the course", async () => {
    const { tenant, course, skill } = await setup();
    const { user: outsider } = await createTenantUser("STUDENT");
    await mapCourseSkill(course.id, skill.id);
    await enrollment(outsider.id, course.id, "COMPLETED");

    const result = await reconcileCourseCompletionEvidence({
      tenantId: tenant.id,
      userId: outsider.id,
      courseId: course.id,
    });

    expect(result.skipped).toBe("tenant-mismatch");
    expect(await db.skillEvidence.count({ where: { userId: outsider.id } })).toBe(0);
  });

  it("ignores a cross-tenant CourseSkill mapping and still reconciles the valid ones", async () => {
    const { tenant, course, skill, learner } = await setup();
    const { tenant: otherTenant } = await createTenantUser();
    const foreignSkill = await createSkill(otherTenant.id);
    await mapCourseSkill(course.id, skill.id);
    await mapCourseSkill(course.id, foreignSkill.id);
    await enrollment(learner.id, course.id, "COMPLETED");

    const result = await reconcileCourseCompletionEvidence({
      tenantId: tenant.id,
      userId: learner.id,
      courseId: course.id,
    });

    expect(result.created).toBe(1);
    expect(await evidenceFor(learner.id, foreignSkill.id)).toHaveLength(0);
  });

  it("no-tenant behavior follows the existing capability rules: a solo course and a solo learner never receive evidence", async () => {
    const { tenant } = await createTenantUser("INSTRUCTOR");
    const solo = await db.user.create({
      data: {
        clerkId: `solo-${Date.now()}`,
        email: `solo-${Date.now()}@example.test`,
        role: "STUDENT",
      },
    });
    const soloInstructor = await db.user.create({
      data: {
        clerkId: `solo-i-${Date.now()}`,
        email: `solo-i-${Date.now()}@example.test`,
        role: "INSTRUCTOR",
      },
    });
    const { course } = await createCourse(tenant.id, soloInstructor.id);
    await db.course.update({ where: { id: course.id }, data: { tenantId: null } });
    const skill = await createSkill(tenant.id);
    await mapCourseSkill(course.id, skill.id);
    await enrollment(solo.id, course.id, "COMPLETED");

    const result = await reconcileCourseCompletionEvidence({
      tenantId: tenant.id,
      userId: solo.id,
      courseId: course.id,
    });

    expect(result.skipped).toBe("tenant-mismatch");
    expect(await db.skillEvidence.count({ where: { userId: solo.id } })).toBe(0);
  });
});

describe("reconcileCourseCompletionEvidence — idempotency and existing evidence", () => {
  it("repeated reconciliation never duplicates evidence", async () => {
    const { tenant, course, skill, learner } = await setup();
    await mapCourseSkill(course.id, skill.id);
    await enrollment(learner.id, course.id, "COMPLETED");
    const params = { tenantId: tenant.id, userId: learner.id, courseId: course.id };

    const first = await reconcileCourseCompletionEvidence(params);
    const second = await reconcileCourseCompletionEvidence(params);
    const third = await reconcileCourseCompletionEvidence(params);

    expect([first.created, second.created, third.created]).toEqual([1, 0, 0]);
    expect(await evidenceFor(learner.id, skill.id)).toHaveLength(1);
  });

  it("reconciling after the live completion path already wrote the evidence is a no-op", async () => {
    const { tenant, course, skill, learner } = await setup();
    await mapCourseSkill(course.id, skill.id);
    const completed = await enrollment(learner.id, course.id, "COMPLETED");
    await recordCourseCompletionOutcome({
      tenantId: tenant.id,
      userId: learner.id,
      courseId: course.id,
      enrollmentId: completed.id,
      completedAt: new Date(),
    });

    const result = await reconcileCourseCompletionEvidence({
      tenantId: tenant.id,
      userId: learner.id,
      courseId: course.id,
    });

    expect(result.created).toBe(0);
    expect(await evidenceFor(learner.id, skill.id)).toHaveLength(1);
  });

  it("concurrent reconciliation produces exactly one evidence row and a correct UserSkill", async () => {
    const { tenant, course, skill, learner } = await setup();
    await mapCourseSkill(course.id, skill.id);
    await enrollment(learner.id, course.id, "COMPLETED");
    const params = { tenantId: tenant.id, userId: learner.id, courseId: course.id };

    const results = await Promise.all(
      Array.from({ length: 6 }, () => reconcileCourseCompletionEvidence(params))
    );

    expect(await evidenceFor(learner.id, skill.id)).toHaveLength(1);
    expect(results.reduce((sum, r) => sum + r.created, 0)).toBe(1);
    const userSkill = await db.userSkill.findUnique({
      where: { userId_skillId: { userId: learner.id, skillId: skill.id } },
    });
    expect(userSkill?.proficiency).toBe("BEGINNER");
  });

  it("concurrent live completion and reconciliation produce exactly one evidence row", async () => {
    const { tenant, course, skill, learner } = await setup();
    await mapCourseSkill(course.id, skill.id);
    const completed = await enrollment(learner.id, course.id, "COMPLETED");

    await Promise.all([
      recordCourseCompletionOutcome({
        tenantId: tenant.id,
        userId: learner.id,
        courseId: course.id,
        enrollmentId: completed.id,
        completedAt: new Date(),
      }),
      reconcileCourseCompletionEvidence({
        tenantId: tenant.id,
        userId: learner.id,
        courseId: course.id,
      }),
    ]);

    expect(await evidenceFor(learner.id, skill.id)).toHaveLength(1);
  });

  it("VERIFIED evidence stays VERIFIED and its verification fields are untouched", async () => {
    const { tenant, instructorCtx, course, skill, learner } = await setup();
    await mapCourseSkill(course.id, skill.id);
    const completed = await enrollment(learner.id, course.id, "COMPLETED");
    await recordCourseCompletionOutcome({
      tenantId: tenant.id,
      userId: learner.id,
      courseId: course.id,
      enrollmentId: completed.id,
      completedAt: new Date(),
    });
    const [original] = await evidenceFor(learner.id, skill.id);
    await verifyEvidence(instructorCtx, original.id);
    const [verified] = await evidenceFor(learner.id, skill.id);
    expect(verified.verificationStatus).toBe("VERIFIED");

    await reconcileCourseCompletionEvidence({
      tenantId: tenant.id,
      userId: learner.id,
      courseId: course.id,
    });

    const after = await evidenceFor(learner.id, skill.id);
    expect(after).toHaveLength(1);
    expect(after[0]).toEqual(verified);
    const userSkill = await db.userSkill.findUnique({
      where: { userId_skillId: { userId: learner.id, skillId: skill.id } },
    });
    expect(userSkill?.proficiency).toBe("INTERMEDIATE");
  });

  it("REJECTED evidence stays REJECTED — reconciliation never resurrects or duplicates it", async () => {
    const { tenant, instructorCtx, course, skill, learner } = await setup();
    await mapCourseSkill(course.id, skill.id);
    const completed = await enrollment(learner.id, course.id, "COMPLETED");
    await recordCourseCompletionOutcome({
      tenantId: tenant.id,
      userId: learner.id,
      courseId: course.id,
      enrollmentId: completed.id,
      completedAt: new Date(),
    });
    const [original] = await evidenceFor(learner.id, skill.id);
    await rejectEvidence(instructorCtx, original.id);

    const result = await reconcileCourseCompletionEvidence({
      tenantId: tenant.id,
      userId: learner.id,
      courseId: course.id,
    });

    expect(result.created).toBe(0);
    const after = await evidenceFor(learner.id, skill.id);
    expect(after).toHaveLength(1);
    expect(after[0].verificationStatus).toBe("REJECTED");
    const userSkill = await db.userSkill.findUnique({
      where: { userId_skillId: { userId: learner.id, skillId: skill.id } },
    });
    expect(userSkill?.proficiency).toBe("NONE");
  });

  it("never downgrades an existing UserSkill: higher proficiency from other verified evidence is preserved", async () => {
    const { tenant, instructorCtx, course, skill, learner } = await setup();
    await mapCourseSkill(course.id, skill.id);

    // Earn INTERMEDIATE first, from a verified quiz pass in a different course
    // that teaches the same skill.
    const quizCourse = await createCourse(tenant.id, instructorCtx.userId);
    await mapCourseSkill(quizCourse.course.id, skill.id);
    const quiz = await createQuiz(quizCourse.lesson.id);
    const attempt = await createQuizAttempt(learner.id, quiz.id, 95, true);
    await recordQuizOutcome({
      tenantId: tenant.id,
      userId: learner.id,
      quizId: quiz.id,
      attemptId: attempt.id,
      score: 95,
      isPassed: true,
      occurredAt: new Date(),
    });
    const [quizEvidence] = await evidenceFor(learner.id, skill.id);
    await verifyEvidence(instructorCtx, quizEvidence.id);
    const before = await db.userSkill.findUnique({
      where: { userId_skillId: { userId: learner.id, skillId: skill.id } },
    });
    expect(before?.proficiency).toBe("INTERMEDIATE");

    await enrollment(learner.id, course.id, "COMPLETED");
    await reconcileCourseCompletionEvidence({
      tenantId: tenant.id,
      userId: learner.id,
      courseId: course.id,
    });

    const after = await db.userSkill.findUnique({
      where: { userId_skillId: { userId: learner.id, skillId: skill.id } },
    });
    expect(after?.proficiency).toBe("INTERMEDIATE");
    expect(after?.lastAssessedAt?.getTime()).toBe(before?.lastAssessedAt?.getTime());
    expect(await evidenceFor(learner.id, skill.id)).toHaveLength(2);
  });
});

describe("reconcileCourseCompletionEvidence — failure isolation and recovery", () => {
  it("attempts every skill, throws an aggregate error, and a plain re-run recovers the failed skill", async () => {
    const { tenant, course, skill, learner } = await setup();
    const skillB = await createSkill(tenant.id);
    await mapCourseSkill(course.id, skill.id);
    await mapCourseSkill(course.id, skillB.id);
    await enrollment(learner.id, course.id, "COMPLETED");
    const params = { tenantId: tenant.id, userId: learner.id, courseId: course.id };

    vi.spyOn(db, "$transaction").mockRejectedValueOnce(new Error("transient database failure"));
    await expect(reconcileCourseCompletionEvidence(params)).rejects.toBeInstanceOf(
      CourseCompletionEvidenceError
    );
    vi.restoreAllMocks();

    // One skill's failure did not stop the other from being written.
    expect(await db.skillEvidence.count({ where: { userId: learner.id } })).toBe(1);

    const recovered = await reconcileCourseCompletionEvidence(params);
    expect(recovered).toMatchObject({ created: 1, alreadyPresent: 1 });
    expect(await db.skillEvidence.count({ where: { userId: learner.id } })).toBe(2);
  });
});

describe("recordCourseCompletionOutcome — evidence failures are no longer swallowed", () => {
  it("rethrows an evidence failure but still emits the LearningEvent, and is safe to retry", async () => {
    const { tenant, course, skill, learner } = await setup();
    await mapCourseSkill(course.id, skill.id);
    const completed = await enrollment(learner.id, course.id, "COMPLETED");
    const params = {
      tenantId: tenant.id,
      userId: learner.id,
      courseId: course.id,
      enrollmentId: completed.id,
      completedAt: new Date(),
    };

    vi.spyOn(db, "$transaction").mockRejectedValueOnce(new Error("transient database failure"));
    await expect(recordCourseCompletionOutcome(params)).rejects.toBeInstanceOf(
      CourseCompletionEvidenceError
    );
    vi.restoreAllMocks();

    expect(await evidenceFor(learner.id, skill.id)).toHaveLength(0);
    expect(
      await db.learningEvent.count({ where: { userId: learner.id, eventType: "COURSE_COMPLETED" } })
    ).toBe(1);

    await reconcileCourseCompletionEvidence({
      tenantId: tenant.id,
      userId: learner.id,
      courseId: course.id,
    });
    expect(await evidenceFor(learner.id, skill.id)).toHaveLength(1);
  });
});

describe("late CourseSkill mapping — addCourseSkill reconciles completed learners", () => {
  it("a learner who completed the course before the skill was mapped receives the evidence", async () => {
    const { instructorCtx, course, skill, learner } = await setup();
    await enrollment(learner.id, course.id, "COMPLETED");
    expect(await evidenceFor(learner.id, skill.id)).toHaveLength(0);

    await addCourseSkill(instructorCtx, course.slug, { skillId: skill.id });

    const [row] = await evidenceFor(learner.id, skill.id);
    expect(row.type).toBe("COURSE_COMPLETION");
    expect(row.sourceId).toBe(course.id);
    const userSkill = await db.userSkill.findUnique({
      where: { userId_skillId: { userId: learner.id, skillId: skill.id } },
    });
    expect(userSkill?.proficiency).toBe("BEGINNER");
  });

  it("an incomplete learner receives nothing", async () => {
    const { instructorCtx, course, skill, learner } = await setup();
    await enrollment(learner.id, course.id, "ACTIVE");

    await addCourseSkill(instructorCtx, course.slug, { skillId: skill.id });

    expect(await evidenceFor(learner.id, skill.id)).toHaveLength(0);
  });

  it("reconciles every completed learner and only them", async () => {
    const { tenant, instructorCtx, course, skill } = await setup();
    const completedA = await createUserInTenant(tenant.id, "STUDENT");
    const completedB = await createUserInTenant(tenant.id, "STUDENT");
    const completedC = await createUserInTenant(tenant.id, "STUDENT");
    const active = await createUserInTenant(tenant.id, "STUDENT");
    const refunded = await createUserInTenant(tenant.id, "STUDENT");
    for (const user of [completedA, completedB, completedC]) {
      await enrollment(user.id, course.id, "COMPLETED");
    }
    await enrollment(active.id, course.id, "ACTIVE");
    await enrollment(refunded.id, course.id, "REFUNDED");

    await addCourseSkill(instructorCtx, course.slug, { skillId: skill.id });

    const rows = await db.skillEvidence.findMany({ where: { skillId: skill.id } });
    expect(rows.map((r) => r.userId).sort()).toEqual(
      [completedA.id, completedB.id, completedC.id].sort()
    );
  });

  it("does not reconcile a completed learner from another tenant", async () => {
    const { instructorCtx, course, skill } = await setup();
    const { user: outsider } = await createTenantUser("STUDENT");
    await enrollment(outsider.id, course.id, "COMPLETED");

    await addCourseSkill(instructorCtx, course.slug, { skillId: skill.id });

    expect(await evidenceFor(outsider.id, skill.id)).toHaveLength(0);
  });

  it("only the newly added skill is reconciled — existing mappings are not redundantly backfilled", async () => {
    const { tenant, instructorCtx, course, skill, learner } = await setup();
    const existingSkill = await createSkill(tenant.id);
    await mapCourseSkill(course.id, existingSkill.id);
    await enrollment(learner.id, course.id, "COMPLETED");

    await addCourseSkill(instructorCtx, course.slug, { skillId: skill.id });

    expect(await evidenceFor(learner.id, skill.id)).toHaveLength(1);
    expect(await evidenceFor(learner.id, existingSkill.id)).toHaveLength(0);
  });

  it("repeating the backfill (or re-running it directly) never duplicates evidence", async () => {
    const { tenant, instructorCtx, course, skill, learner } = await setup();
    await enrollment(learner.id, course.id, "COMPLETED");
    await addCourseSkill(instructorCtx, course.slug, { skillId: skill.id });

    const rerun = await reconcileCompletedLearnersForCourseSkill({
      tenantId: tenant.id,
      courseId: course.id,
      skillId: skill.id,
    });

    expect(rerun).toMatchObject({ considered: 1, created: 0, failed: [] });
    expect(await evidenceFor(learner.id, skill.id)).toHaveLength(1);
  });

  it("existing verified evidence and proficiency survive a remap", async () => {
    const { instructorCtx, course, skill, learner } = await setup();
    await enrollment(learner.id, course.id, "COMPLETED");
    await addCourseSkill(instructorCtx, course.slug, { skillId: skill.id });
    const [original] = await evidenceFor(learner.id, skill.id);
    await verifyEvidence(instructorCtx, original.id);
    const verified = (await evidenceFor(learner.id, skill.id))[0];

    await db.courseSkill.deleteMany({ where: { courseId: course.id, skillId: skill.id } });
    await addCourseSkill(instructorCtx, course.slug, { skillId: skill.id });

    const after = await evidenceFor(learner.id, skill.id);
    expect(after).toHaveLength(1);
    expect(after[0]).toEqual(verified);
    const userSkill = await db.userSkill.findUnique({
      where: { userId_skillId: { userId: learner.id, skillId: skill.id } },
    });
    expect(userSkill?.proficiency).toBe("INTERMEDIATE");
  });

  it("cross-tenant CourseSkill/Skill combinations are still rejected and create no evidence", async () => {
    const { instructorCtx, course, learner } = await setup();
    const { tenant: otherTenant } = await createTenantUser();
    const foreignSkill = await createSkill(otherTenant.id);
    await enrollment(learner.id, course.id, "COMPLETED");

    await expect(
      addCourseSkill(instructorCtx, course.slug, { skillId: foreignSkill.id })
    ).rejects.toMatchObject({ status: 404 });

    expect(await evidenceFor(learner.id, foreignSkill.id)).toHaveLength(0);
    expect(await db.courseSkill.count({ where: { courseId: course.id } })).toBe(0);
  });

  it("a duplicate mapping still returns 409 and does not re-run or duplicate the backfill", async () => {
    const { instructorCtx, course, skill, learner } = await setup();
    await enrollment(learner.id, course.id, "COMPLETED");
    await addCourseSkill(instructorCtx, course.slug, { skillId: skill.id });

    await expect(
      addCourseSkill(instructorCtx, course.slug, { skillId: skill.id })
    ).rejects.toMatchObject({ status: 409 });

    expect(await evidenceFor(learner.id, skill.id)).toHaveLength(1);
  });

  it("a backfill failure never fails or rolls back the mapping, is logged, and is recoverable", async () => {
    const { tenant, instructorCtx, course, skill, learner } = await setup();
    await enrollment(learner.id, course.id, "COMPLETED");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    vi.spyOn(db, "$transaction").mockRejectedValueOnce(new Error("transient database failure"));
    const added = await addCourseSkill(instructorCtx, course.slug, { skillId: skill.id });
    vi.restoreAllMocks();

    expect(added.skillId).toBe(skill.id);
    expect(await db.courseSkill.count({ where: { courseId: course.id, skillId: skill.id } })).toBe(
      1
    );
    expect(await evidenceFor(learner.id, skill.id)).toHaveLength(0);
    expect(errorLog).toHaveBeenCalled();

    const recovered = await reconcileCompletedLearnersForCourseSkill({
      tenantId: tenant.id,
      courseId: course.id,
      skillId: skill.id,
    });
    expect(recovered).toMatchObject({ created: 1, failed: [] });
    expect(await evidenceFor(learner.id, skill.id)).toHaveLength(1);
  });

  it("a solo (no-tenant) course can still never have a skill mapped, so no backfill can occur", async () => {
    const { tenant } = await createTenantUser("INSTRUCTOR");
    const soloInstructor = await db.user.create({
      data: {
        clerkId: `solo-i2-${Date.now()}`,
        email: `solo-i2-${Date.now()}@example.test`,
        role: "INSTRUCTOR",
      },
    });
    const { course } = await createCourse(tenant.id, soloInstructor.id);
    await db.course.update({ where: { id: course.id }, data: { tenantId: null } });
    const skill = await createSkill(tenant.id);

    await expect(
      addCourseSkill(
        {
          userId: soloInstructor.id,
          clerkId: soloInstructor.clerkId,
          tenantId: null,
          role: "INSTRUCTOR",
        } as never,
        course.slug,
        { skillId: skill.id }
      )
    ).rejects.toMatchObject({ status: 404 });
  });
});
