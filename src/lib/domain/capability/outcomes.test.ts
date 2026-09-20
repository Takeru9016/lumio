import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  createAssignment,
  createAssignmentSubmission,
  createCourse,
  createQuiz,
  createSkill,
  mapCourseSkill,
} from "@/lib/domain/capability/__test__/fixtures";
import {
  recordAssignmentGradeOutcome,
  recordCourseCompletionOutcome,
  recordQuizOutcome,
} from "@/lib/domain/capability/outcomes";
import { createTenantUser } from "@/lib/domain/knowledge/__test__/fixtures";

afterEach(() => {
  vi.restoreAllMocks();
});

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
    expect(userSkills.every((s) => s.confidence === null)).toBe(true);
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

  /**
   * KNOWN GAP, deliberately not fixed in this turn (Phase 5 final contract
   * audit, 2026-09-11) — flagged for an explicit approval decision rather
   * than silently patched or silently ignored. `emitLearningEvent` has no
   * idempotency check of any kind (no DB constraint on LearningEvent, no
   * application-level pre-check in emit.ts or outcomes.ts). The ONLY thing
   * that prevents a duplicate COURSE_COMPLETED event in production is the
   * caller route's `enrollment.status !== "COMPLETED"` gate — which reliably
   * stops a SEQUENTIAL retry arriving after the first request's enrollment
   * update has committed, but does nothing for two genuinely concurrent
   * requests that both read the pre-commit enrollment snapshot (the same
   * class of race Challenge 1 identified for SkillEvidence — here left
   * unmitigated). This test proves the gap exists rather than asserting a
   * false guarantee. SkillEvidence/UserSkill correctness is NOT affected —
   * only the LearningEvent audit stream can double-write, and nothing
   * currently consumes LearningEvent. See the audit report for the two
   * candidate fixes (an application-level conditional enrollment update, or
   * a LearningEvent uniqueness constraint) — neither is applied here.
   */
  it("documents a known gap: concurrent duplicate outcomes are NOT deduplicated for LearningEvent", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course } = await createCourse(tenant.id, instructorCtx.userId);

    const params = {
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      courseId: course.id,
      enrollmentId: "test-enrollment",
      completedAt: new Date(),
    };

    await Promise.all([
      recordCourseCompletionOutcome(params),
      recordCourseCompletionOutcome(params),
    ]);

    const events = await db.learningEvent.findMany({
      where: { userId: learnerCtx.userId, eventType: "COURSE_COMPLETED" },
    });
    // NOT `toHaveLength(1)` — this documents the actual current behavior.
    expect(events.length).toBe(2);
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
    // Phase 25: keyed by the quiz, not the attempt, so repeated passes converge.
    expect(evidence[0].sourceType).toBe("Quiz");
    expect(evidence[0].sourceId).toBe(quiz.id);
    expect(evidence[0].score).toBe(90);
    expect(evidence[0].verificationStatus).toBe("UNVERIFIED");

    const userSkill = await db.userSkill.findUniqueOrThrow({
      where: { userId_skillId: { userId: learnerCtx.userId, skillId: skill.id } },
    });
    expect(userSkill.confidence).toBeNull();
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

  it("passing the same quiz again with a new attempt id records no second evidence row", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course, lesson } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);
    await mapCourseSkill(course.id, skill.id);
    const quiz = await createQuiz(lesson.id);
    const outcome = (attemptId: string, score: number) =>
      recordQuizOutcome({
        tenantId: tenant.id,
        userId: learnerCtx.userId,
        quizId: quiz.id,
        attemptId,
        score,
        isPassed: true,
        occurredAt: new Date(),
      });

    await outcome("attempt-a", 75);
    await outcome("attempt-b", 100);
    await outcome("attempt-c", 90);

    const evidence = await db.skillEvidence.findMany({ where: { userId: learnerCtx.userId } });
    expect(evidence).toHaveLength(1);
    // The row keeps the score of the pass that created it.
    expect(evidence[0].score).toBe(75);
    // Every attempt is still a real, recorded learning event.
    const events = await db.learningEvent.findMany({
      where: { userId: learnerCtx.userId, eventType: "QUIZ_COMPLETED" },
    });
    expect(events).toHaveLength(3);
  });

  it("keeps one row per mapped skill, however many passes there are", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course, lesson } = await createCourse(tenant.id, instructorCtx.userId);
    const skillA = await createSkill(tenant.id);
    const skillB = await createSkill(tenant.id);
    await mapCourseSkill(course.id, skillA.id);
    await mapCourseSkill(course.id, skillB.id);
    const quiz = await createQuiz(lesson.id);

    for (const attemptId of ["a1", "a2", "a3"]) {
      await recordQuizOutcome({
        tenantId: tenant.id,
        userId: learnerCtx.userId,
        quizId: quiz.id,
        attemptId,
        score: 90,
        isPassed: true,
        occurredAt: new Date(),
      });
    }

    const evidence = await db.skillEvidence.findMany({ where: { userId: learnerCtx.userId } });
    expect(evidence).toHaveLength(2);
    expect(new Set(evidence.map((row) => row.skillId))).toEqual(new Set([skillA.id, skillB.id]));
  });

  it("concurrent passing outcomes for one learner and quiz produce a single row", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course, lesson } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);
    await mapCourseSkill(course.id, skill.id);
    const quiz = await createQuiz(lesson.id);

    await Promise.all(
      ["c1", "c2", "c3", "c4", "c5"].map((attemptId) =>
        recordQuizOutcome({
          tenantId: tenant.id,
          userId: learnerCtx.userId,
          quizId: quiz.id,
          attemptId,
          score: 90,
          isPassed: true,
          occurredAt: new Date(),
        })
      )
    );

    expect(await db.skillEvidence.count({ where: { userId: learnerCtx.userId } })).toBe(1);
  });

  it("evidence for different quizzes stays separate", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const first = await createCourse(tenant.id, instructorCtx.userId);
    const second = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);
    await mapCourseSkill(first.course.id, skill.id);
    await mapCourseSkill(second.course.id, skill.id);
    const quizA = await createQuiz(first.lesson.id);
    const quizB = await createQuiz(second.lesson.id);

    for (const quiz of [quizA, quizB]) {
      await recordQuizOutcome({
        tenantId: tenant.id,
        userId: learnerCtx.userId,
        quizId: quiz.id,
        attemptId: `attempt-${quiz.id}`,
        score: 90,
        isPassed: true,
        occurredAt: new Date(),
      });
    }

    const evidence = await db.skillEvidence.findMany({ where: { userId: learnerCtx.userId } });
    expect(evidence.map((row) => row.sourceId).sort()).toEqual([quizA.id, quizB.id].sort());
  });

  it("does not add a row for a skill the learner already has per-attempt (legacy) quiz evidence for, and leaves historical duplicates alone", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course, lesson } = await createCourse(tenant.id, instructorCtx.userId);
    const covered = await createSkill(tenant.id);
    const fresh = await createSkill(tenant.id);
    await mapCourseSkill(course.id, covered.id);
    await mapCourseSkill(course.id, fresh.id);
    const quiz = await createQuiz(lesson.id);
    const attempts = await Promise.all(
      [90, 95].map((score) =>
        db.quizAttempt.create({
          data: { userId: learnerCtx.userId, quizId: quiz.id, score, isPassed: true },
        })
      )
    );
    for (const attempt of attempts) {
      await db.skillEvidence.create({
        data: {
          tenantId: tenant.id,
          userId: learnerCtx.userId,
          skillId: covered.id,
          type: "QUIZ_SCORE",
          sourceType: "QuizAttempt",
          sourceId: attempt.id,
          score: 90,
        },
      });
    }

    await recordQuizOutcome({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      quizId: quiz.id,
      attemptId: "a-new-pass",
      score: 100,
      isPassed: true,
      occurredAt: new Date(),
    });

    const evidence = await db.skillEvidence.findMany({ where: { userId: learnerCtx.userId } });
    const coveredRows = evidence.filter((row) => row.skillId === covered.id);
    const freshRows = evidence.filter((row) => row.skillId === fresh.id);
    // The covered skill keeps its two historical rows and gains none.
    expect(coveredRows).toHaveLength(2);
    expect(coveredRows.every((row) => row.sourceType === "QuizAttempt")).toBe(true);
    // A skill with no earlier quiz evidence gets the new, quiz-keyed row.
    expect(freshRows).toHaveLength(1);
    expect(freshRows[0]).toMatchObject({ sourceType: "Quiz", sourceId: quiz.id });
  });

  it("a passing attempt never changes the projected proficiency after the first", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course, lesson } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);
    await mapCourseSkill(course.id, skill.id);
    const quiz = await createQuiz(lesson.id);
    const pass = (attemptId: string) =>
      recordQuizOutcome({
        tenantId: tenant.id,
        userId: learnerCtx.userId,
        quizId: quiz.id,
        attemptId,
        score: 90,
        isPassed: true,
        occurredAt: new Date(),
      });

    await pass("p1");
    const first = await db.userSkill.findUniqueOrThrow({
      where: { userId_skillId: { userId: learnerCtx.userId, skillId: skill.id } },
    });
    await pass("p2");
    await pass("p3");

    const later = await db.userSkill.findUniqueOrThrow({
      where: { userId_skillId: { userId: learnerCtx.userId, skillId: skill.id } },
    });
    expect(first.proficiency).toBe("BEGINNER");
    expect(later.proficiency).toBe("BEGINNER");
    expect(later.lastAssessedAt?.getTime()).toBe(first.lastAssessedAt?.getTime());
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

describe("recordQuizOutcome — failure isolation", () => {
  async function passedQuiz() {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course, lesson } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);
    await mapCourseSkill(course.id, skill.id);
    const quiz = await createQuiz(lesson.id);
    const outcome = (attemptId = "iso-attempt") => ({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      quizId: quiz.id,
      attemptId,
      score: 100,
      isPassed: true,
      occurredAt: new Date(),
    });
    return { tenant, course, skill, quiz, userId: learnerCtx.userId, outcome };
  }
  const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});
  const events = (userId: string) =>
    db.learningEvent.findMany({ where: { userId, eventType: "QUIZ_COMPLETED" } });

  it("a failing quiz lookup never throws: it is logged, no evidence is written, and the event is still recorded", async () => {
    const s = await passedQuiz();
    const logged = quiet();
    vi.spyOn(db.quiz, "findUnique").mockRejectedValue(new Error("lookup-boom"));

    await expect(recordQuizOutcome(s.outcome("iso-lookup"))).resolves.toBeUndefined();

    expect(await db.skillEvidence.count({ where: { userId: s.userId } })).toBe(0);
    expect(await db.userSkill.count({ where: { userId: s.userId } })).toBe(0);
    const emitted = await events(s.userId);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].entityId).toBe("iso-lookup");
    expect(emitted[0].metadata).toMatchObject({ quizId: s.quiz.id, isPassed: true });
    expect(logged).toHaveBeenCalledTimes(1);
    const [message, error] = logged.mock.calls[0];
    expect(message).toContain("[capability]");
    expect(message).toContain(s.quiz.id);
    expect(message).toContain("iso-lookup");
    expect(error).toBeInstanceOf(Error);
  });

  it("a failed lookup is not sticky: the next outcome records the evidence normally", async () => {
    const s = await passedQuiz();
    quiet();
    const lookup = vi.spyOn(db.quiz, "findUnique").mockRejectedValueOnce(new Error("lookup-boom"));

    await recordQuizOutcome(s.outcome("iso-first"));
    expect(await db.skillEvidence.count({ where: { userId: s.userId } })).toBe(0);
    await recordQuizOutcome(s.outcome("iso-second"));

    expect(lookup).toHaveBeenCalledTimes(2);
    const rows = await db.skillEvidence.findMany({ where: { userId: s.userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sourceType: "Quiz", sourceId: s.quiz.id });
  });

  it("a failing CourseSkill lookup never throws and still records the event with its course", async () => {
    const s = await passedQuiz();
    const logged = quiet();
    vi.spyOn(db.courseSkill, "findMany").mockRejectedValue(new Error("mapping-boom"));

    await expect(recordQuizOutcome(s.outcome("iso-mapping"))).resolves.toBeUndefined();

    expect(await db.skillEvidence.count({ where: { userId: s.userId } })).toBe(0);
    expect(await db.userSkill.count({ where: { userId: s.userId } })).toBe(0);
    const emitted = await events(s.userId);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].metadata).toMatchObject({ courseId: s.course.id });
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it("a failing LearningEvent write never throws and leaves the evidence and UserSkill intact", async () => {
    const s = await passedQuiz();
    const logged = quiet();
    vi.spyOn(db.learningEvent, "create").mockRejectedValue(new Error("event-boom"));

    await expect(recordQuizOutcome(s.outcome("iso-event"))).resolves.toBeUndefined();

    const rows = await db.skillEvidence.findMany({ where: { userId: s.userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sourceType: "Quiz", sourceId: s.quiz.id, score: 100 });
    expect(await db.userSkill.count({ where: { userId: s.userId } })).toBe(1);
    expect(await events(s.userId)).toHaveLength(0);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0][0]).toContain("iso-event");
  });

  it("with everything healthy it still records the evidence, the projection and one event with its course", async () => {
    const s = await passedQuiz();

    await recordQuizOutcome(s.outcome("iso-ok"));

    expect(await db.skillEvidence.count({ where: { userId: s.userId } })).toBe(1);
    expect(await db.userSkill.count({ where: { userId: s.userId } })).toBe(1);
    const emitted = await events(s.userId);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].metadata).toMatchObject({ courseId: s.course.id });
  });
});

describe("recordAssignmentGradeOutcome", () => {
  it("a graded submission creates ASSESSMENT evidence for every mapped skill, owned by the student", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course, lesson } = await createCourse(tenant.id, instructorCtx.userId);
    const skillA = await createSkill(tenant.id);
    const skillB = await createSkill(tenant.id);
    await mapCourseSkill(course.id, skillA.id);
    await mapCourseSkill(course.id, skillB.id);
    const assignment = await createAssignment(lesson.id);
    const submission = await createAssignmentSubmission(learnerCtx.userId, assignment.id);

    await recordAssignmentGradeOutcome({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      assignmentId: assignment.id,
      submissionId: submission.id,
      score: 40,
      maxScore: 100,
      occurredAt: new Date(),
    });

    const evidence = await db.skillEvidence.findMany({ where: { userId: learnerCtx.userId } });
    expect(evidence).toHaveLength(2);
    expect(evidence.every((e) => e.type === "ASSESSMENT")).toBe(true);
    expect(
      evidence.every((e) => e.sourceType === "AssignmentSubmission" && e.sourceId === submission.id)
    ).toBe(true);
    expect(evidence.every((e) => e.score === 40)).toBe(true);
    expect(evidence.every((e) => e.verificationStatus === "UNVERIFIED")).toBe(true);

    const userSkills = await db.userSkill.findMany({ where: { userId: learnerCtx.userId } });
    expect(userSkills).toHaveLength(2);
  });

  it("a low-scoring graded submission still creates evidence — no pass/fail concept exists for assignments", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course, lesson } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);
    await mapCourseSkill(course.id, skill.id);
    const assignment = await createAssignment(lesson.id);
    const submission = await createAssignmentSubmission(learnerCtx.userId, assignment.id);

    await recordAssignmentGradeOutcome({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      assignmentId: assignment.id,
      submissionId: submission.id,
      score: 5,
      maxScore: 100,
      occurredAt: new Date(),
    });

    const evidence = await db.skillEvidence.findMany({ where: { userId: learnerCtx.userId } });
    expect(evidence).toHaveLength(1);
    expect(evidence[0].score).toBe(5);
  });

  it("creates no evidence when the course has no CourseSkill mappings, but still emits ASSIGNMENT_GRADED", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { lesson } = await createCourse(tenant.id, instructorCtx.userId);
    const assignment = await createAssignment(lesson.id);
    const submission = await createAssignmentSubmission(learnerCtx.userId, assignment.id);

    await recordAssignmentGradeOutcome({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      assignmentId: assignment.id,
      submissionId: submission.id,
      score: 80,
      maxScore: 100,
      occurredAt: new Date(),
    });

    const evidence = await db.skillEvidence.findMany({ where: { userId: learnerCtx.userId } });
    expect(evidence).toHaveLength(0);

    const events = await db.learningEvent.findMany({
      where: { userId: learnerCtx.userId, eventType: "ASSIGNMENT_GRADED" },
    });
    expect(events).toHaveLength(1);
  });

  it("skips a cross-tenant CourseSkill mapping and still processes valid ones, without throwing", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { tenant: otherTenant } = await createTenantUser();
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course, lesson } = await createCourse(tenant.id, instructorCtx.userId);
    const validSkill = await createSkill(tenant.id);
    const crossTenantSkill = await createSkill(otherTenant.id);
    await mapCourseSkill(course.id, validSkill.id);
    await mapCourseSkill(course.id, crossTenantSkill.id);
    const assignment = await createAssignment(lesson.id);
    const submission = await createAssignmentSubmission(learnerCtx.userId, assignment.id);

    await recordAssignmentGradeOutcome({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      assignmentId: assignment.id,
      submissionId: submission.id,
      score: 60,
      maxScore: 100,
      occurredAt: new Date(),
    });

    const evidence = await db.skillEvidence.findMany({ where: { userId: learnerCtx.userId } });
    expect(evidence).toHaveLength(1);
    expect(evidence[0].skillId).toBe(validSkill.id);
  });

  it("emits ASSIGNMENT_GRADED with assignmentId/courseId/score/maxScore metadata and no isPassed field", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course, lesson } = await createCourse(tenant.id, instructorCtx.userId);
    const assignment = await createAssignment(lesson.id, 50);
    const submission = await createAssignmentSubmission(learnerCtx.userId, assignment.id);

    await recordAssignmentGradeOutcome({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      assignmentId: assignment.id,
      submissionId: submission.id,
      score: 30,
      maxScore: 50,
      occurredAt: new Date(),
    });

    const events = await db.learningEvent.findMany({
      where: { userId: learnerCtx.userId, eventType: "ASSIGNMENT_GRADED" },
    });
    expect(events).toHaveLength(1);
    expect(events[0].entityType).toBe("AssignmentSubmission");
    expect(events[0].entityId).toBe(submission.id);
    expect(events[0].metadata).toMatchObject({
      assignmentId: assignment.id,
      courseId: course.id,
      score: 30,
      maxScore: 50,
    });
    expect(events[0].metadata).not.toHaveProperty("isPassed");
  });

  it("a regrade of the same submission is idempotent — first evidence wins, no duplicate row", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course, lesson } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);
    await mapCourseSkill(course.id, skill.id);
    const assignment = await createAssignment(lesson.id);
    const submission = await createAssignmentSubmission(learnerCtx.userId, assignment.id);

    await recordAssignmentGradeOutcome({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      assignmentId: assignment.id,
      submissionId: submission.id,
      score: 70,
      maxScore: 100,
      occurredAt: new Date(),
    });
    // Regrade: same stable submission.id (AssignmentSubmission is unique per
    // [userId, assignmentId]) — hits the existing SkillEvidence P2002 no-op.
    await recordAssignmentGradeOutcome({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      assignmentId: assignment.id,
      submissionId: submission.id,
      score: 95,
      maxScore: 100,
      occurredAt: new Date(),
    });

    const evidence = await db.skillEvidence.findMany({
      where: { userId: learnerCtx.userId, skillId: skill.id },
    });
    expect(evidence).toHaveLength(1);
    expect(evidence[0].score).toBe(70);
  });

  it("a regrade that lowers the score never degrades or removes existing evidence", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course, lesson } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);
    await mapCourseSkill(course.id, skill.id);
    const assignment = await createAssignment(lesson.id);
    const submission = await createAssignmentSubmission(learnerCtx.userId, assignment.id);

    await recordAssignmentGradeOutcome({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      assignmentId: assignment.id,
      submissionId: submission.id,
      score: 90,
      maxScore: 100,
      occurredAt: new Date(),
    });
    await recordAssignmentGradeOutcome({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      assignmentId: assignment.id,
      submissionId: submission.id,
      score: 10,
      maxScore: 100,
      occurredAt: new Date(),
    });

    const evidence = await db.skillEvidence.findMany({
      where: { userId: learnerCtx.userId, skillId: skill.id },
    });
    expect(evidence).toHaveLength(1);
    expect(evidence[0].score).toBe(90);

    const userSkill = await db.userSkill.findUniqueOrThrow({
      where: { userId_skillId: { userId: learnerCtx.userId, skillId: skill.id } },
    });
    expect(userSkill.proficiency).toBe("BEGINNER");
  });
});
