import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  createCourse,
  createQuiz,
  createSkill,
  mapCourseSkill,
} from "@/lib/domain/capability/__test__/fixtures";
import { recordCourseCompletionOutcome, recordQuizOutcome } from "@/lib/domain/capability/outcomes";
import { createTenantUser } from "@/lib/domain/knowledge/__test__/fixtures";

afterAll(async () => {
  await db.$disconnect();
});

describe("recordCourseCompletionOutcome — evidence", () => {
  it("creates COURSE_COMPLETION evidence for each mapped skill", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course } = await createCourse(tenant.id, instructorCtx.userId);
    const skillA = await createSkill(tenant.id);
    const skillB = await createSkill(tenant.id);
    await mapCourseSkill(course.id, skillA.id);
    await mapCourseSkill(course.id, skillB.id);

    const completedAt = new Date();
    await recordCourseCompletionOutcome({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      courseId: course.id,
      enrollmentId: "test-enrollment",
      completedAt,
    });

    const evidence = await db.skillEvidence.findMany({ where: { userId: learnerCtx.userId } });
    expect(evidence).toHaveLength(2);
    expect(evidence.every((e) => e.type === "COURSE_COMPLETION")).toBe(true);
    expect(evidence.every((e) => e.sourceType === "Course" && e.sourceId === course.id)).toBe(true);
    expect(evidence.every((e) => e.verificationStatus === "UNVERIFIED")).toBe(true);
    expect(evidence.every((e) => e.score === null)).toBe(true);

    const userSkills = await db.userSkill.findMany({ where: { userId: learnerCtx.userId } });
    expect(userSkills).toHaveLength(2);
    expect(userSkills.every((s) => s.proficiency === "BEGINNER")).toBe(true);
  });

  it("creates no evidence when the course has no CourseSkill mappings", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course } = await createCourse(tenant.id, instructorCtx.userId);

    await recordCourseCompletionOutcome({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      courseId: course.id,
      enrollmentId: "test-enrollment",
      completedAt: new Date(),
    });

    const evidence = await db.skillEvidence.findMany({ where: { userId: learnerCtx.userId } });
    expect(evidence).toHaveLength(0);
  });

  it("skips a cross-tenant CourseSkill mapping and still processes valid ones, without throwing", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { tenant: otherTenant } = await createTenantUser();
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course } = await createCourse(tenant.id, instructorCtx.userId);
    const validSkill = await createSkill(tenant.id);
    const crossTenantSkill = await createSkill(otherTenant.id);
    await mapCourseSkill(course.id, validSkill.id);
    // A malformed mapping: no DB constraint prevents this (see outcomes.ts comment).
    await mapCourseSkill(course.id, crossTenantSkill.id);

    await recordCourseCompletionOutcome({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      courseId: course.id,
      enrollmentId: "test-enrollment",
      completedAt: new Date(),
    });

    const evidence = await db.skillEvidence.findMany({ where: { userId: learnerCtx.userId } });
    expect(evidence).toHaveLength(1);
    expect(evidence[0].skillId).toBe(validSkill.id);
  });

  it("emits exactly one COURSE_COMPLETED LearningEvent", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course } = await createCourse(tenant.id, instructorCtx.userId);

    await recordCourseCompletionOutcome({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      courseId: course.id,
      enrollmentId: "test-enrollment",
      completedAt: new Date(),
    });

    const events = await db.learningEvent.findMany({
      where: { userId: learnerCtx.userId, eventType: "COURSE_COMPLETED" },
    });
    expect(events).toHaveLength(1);
    expect(events[0].entityType).toBe("Course");
    expect(events[0].entityId).toBe(course.id);
  });
});

describe("recordCourseCompletionOutcome — idempotency and concurrency", () => {
  it("a second call with the same outcome does not create a second evidence row", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);
    await mapCourseSkill(course.id, skill.id);

    const params = {
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      courseId: course.id,
      enrollmentId: "test-enrollment",
      completedAt: new Date(),
    };
    await recordCourseCompletionOutcome(params);
    await recordCourseCompletionOutcome(params);

    const evidence = await db.skillEvidence.findMany({ where: { userId: learnerCtx.userId } });
    expect(evidence).toHaveLength(1);
  });

  it("concurrent duplicate outcomes are protected by the database unique constraint — exactly one evidence row survives, neither call throws, UserSkill stays correct", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);
    await mapCourseSkill(course.id, skill.id);

    const params = {
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      courseId: course.id,
      enrollmentId: "test-enrollment",
      completedAt: new Date(),
    };

    // Two genuinely concurrent calls racing the same duplicate-evidence
    // window (Phase 5 architecture challenge, Challenge 1/Challenge 12's
    // "database is the real guarantee, not an application pre-check").
    await Promise.all([
      recordCourseCompletionOutcome(params),
      recordCourseCompletionOutcome(params),
    ]);

    const evidence = await db.skillEvidence.findMany({
      where: { userId: learnerCtx.userId, skillId: skill.id },
    });
    expect(evidence).toHaveLength(1);

    const userSkill = await db.userSkill.findUnique({
      where: { userId_skillId: { userId: learnerCtx.userId, skillId: skill.id } },
    });
    expect(userSkill?.proficiency).toBe("BEGINNER");
  });
});

describe("recordQuizOutcome", () => {
  it("a passing quiz with a CourseSkill mapping creates QUIZ_SCORE evidence with the real score", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course, lesson } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);
    await mapCourseSkill(course.id, skill.id);
    const quiz = await createQuiz(lesson.id);

    await recordQuizOutcome({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      quizId: quiz.id,
      attemptId: "test-attempt-1",
      score: 90,
      isPassed: true,
      occurredAt: new Date(),
    });

    const evidence = await db.skillEvidence.findMany({ where: { userId: learnerCtx.userId } });
    expect(evidence).toHaveLength(1);
    expect(evidence[0].type).toBe("QUIZ_SCORE");
    expect(evidence[0].sourceType).toBe("QuizAttempt");
    expect(evidence[0].sourceId).toBe("test-attempt-1");
    expect(evidence[0].score).toBe(90);
    expect(evidence[0].verificationStatus).toBe("UNVERIFIED");
  });

  it("a failed quiz creates no evidence and does not change UserSkill, but still records a LearningEvent", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course, lesson } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);
    await mapCourseSkill(course.id, skill.id);
    const quiz = await createQuiz(lesson.id);

    await recordQuizOutcome({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      quizId: quiz.id,
      attemptId: "test-attempt-fail",
      score: 20,
      isPassed: false,
      occurredAt: new Date(),
    });

    const evidence = await db.skillEvidence.findMany({ where: { userId: learnerCtx.userId } });
    expect(evidence).toHaveLength(0);
    const userSkill = await db.userSkill.findUnique({
      where: { userId_skillId: { userId: learnerCtx.userId, skillId: skill.id } },
    });
    expect(userSkill).toBeNull();

    const events = await db.learningEvent.findMany({
      where: { userId: learnerCtx.userId, eventType: "QUIZ_COMPLETED" },
    });
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toMatchObject({ isPassed: false, score: 20 });
  });

  it("always emits QUIZ_COMPLETED regardless of pass/fail", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { lesson } = await createCourse(tenant.id, instructorCtx.userId);
    const quiz = await createQuiz(lesson.id);

    await recordQuizOutcome({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      quizId: quiz.id,
      attemptId: "test-attempt-pass",
      score: 100,
      isPassed: true,
      occurredAt: new Date(),
    });

    const events = await db.learningEvent.findMany({
      where: { userId: learnerCtx.userId, eventType: "QUIZ_COMPLETED" },
    });
    expect(events).toHaveLength(1);
    expect(events[0].entityType).toBe("QuizAttempt");
    expect(events[0].entityId).toBe("test-attempt-pass");
  });
});
