import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  createCourse,
  createSkill,
  mapCourseSkill,
} from "@/lib/domain/capability/__test__/fixtures";
import { recordCourseCompletionOutcome } from "@/lib/domain/capability/outcomes";
import { createTenantUser } from "@/lib/domain/knowledge/__test__/fixtures";

afterAll(async () => {
  await db.$disconnect();
});

/**
 * These tests exercise the exact atomic-transition pattern used by
 * src/app/api/courses/[courseId]/lessons/[lessonId]/complete/route.ts (Phase
 * 5 final contract audit fix, 2026-09-11): only the request whose
 * `enrollment.updateMany({ where: { status: { not: "COMPLETED" } } })` call
 * affects a row may run the one-time completion side effects, including
 * recordCourseCompletionOutcome. The route itself is not invoked directly
 * (no existing harness mocks Clerk auth() for route-level tests in this
 * repo) — instead this reproduces the identical DB-level gate so the
 * concurrency guarantee is proven against the real database.
 */
async function attemptCompletionTransition(params: {
  tenantId: string;
  userId: string;
  courseId: string;
  enrollmentId: string;
}) {
  const completedAt = new Date();
  const { count } = await db.enrollment.updateMany({
    where: { id: params.enrollmentId, status: { not: "COMPLETED" } },
    data: { status: "COMPLETED", completedAt },
  });
  if (count === 1) {
    await recordCourseCompletionOutcome({
      tenantId: params.tenantId,
      userId: params.userId,
      courseId: params.courseId,
      enrollmentId: params.enrollmentId,
      completedAt,
    });
  }
  return count === 1;
}

describe("course-completion atomic transition gate", () => {
  it("concurrent completion attempts: exactly one wins, exactly one COURSE_COMPLETED event, exactly one evidence set, no throw", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);
    await mapCourseSkill(course.id, skill.id);
    const enrollment = await db.enrollment.create({
      data: { userId: learnerCtx.userId, courseId: course.id, status: "ACTIVE" },
    });

    const results = await Promise.all([
      attemptCompletionTransition({
        tenantId: tenant.id,
        userId: learnerCtx.userId,
        courseId: course.id,
        enrollmentId: enrollment.id,
      }),
      attemptCompletionTransition({
        tenantId: tenant.id,
        userId: learnerCtx.userId,
        courseId: course.id,
        enrollmentId: enrollment.id,
      }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);

    const finalEnrollment = await db.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } });
    expect(finalEnrollment.status).toBe("COMPLETED");

    const events = await db.learningEvent.findMany({
      where: { userId: learnerCtx.userId, eventType: "COURSE_COMPLETED" },
    });
    expect(events).toHaveLength(1);

    const evidence = await db.skillEvidence.findMany({
      where: { userId: learnerCtx.userId, skillId: skill.id },
    });
    expect(evidence).toHaveLength(1);

    const userSkill = await db.userSkill.findUnique({
      where: { userId_skillId: { userId: learnerCtx.userId, skillId: skill.id } },
    });
    expect(userSkill?.proficiency).toBe("BEGINNER");
  });

  it("sequential retry after completion: zero additional events, zero additional evidence", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);
    await mapCourseSkill(course.id, skill.id);
    const enrollment = await db.enrollment.create({
      data: { userId: learnerCtx.userId, courseId: course.id, status: "ACTIVE" },
    });

    const firstWon = await attemptCompletionTransition({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      courseId: course.id,
      enrollmentId: enrollment.id,
    });
    expect(firstWon).toBe(true);

    const retryWon = await attemptCompletionTransition({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      courseId: course.id,
      enrollmentId: enrollment.id,
    });
    expect(retryWon).toBe(false);

    const events = await db.learningEvent.findMany({
      where: { userId: learnerCtx.userId, eventType: "COURSE_COMPLETED" },
    });
    expect(events).toHaveLength(1);

    const evidence = await db.skillEvidence.findMany({
      where: { userId: learnerCtx.userId, skillId: skill.id },
    });
    expect(evidence).toHaveLength(1);
  });
});
