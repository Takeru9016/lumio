import { auth } from "@clerk/nextjs/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  createCourse,
  createQuiz,
  createSkill,
  mapCourseSkill,
} from "@/lib/domain/capability/__test__/fixtures";
import { createUserInTenant } from "@/lib/domain/course/__test__/fixtures";
import { createTenantUser } from "@/lib/domain/knowledge/__test__/fixtures";

/**
 * POST /api/quizzes/[quizId]/attempt against the REAL database. Only Clerk is
 * mocked. Covers the three Phase 25 guarantees: the answer key is never handed
 * out while it could still help a learner pass, the attempt limit holds under
 * concurrent requests, and repeated passes never multiply quiz evidence.
 */
vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));

const { POST } = await import("./route");

// Distinctive values, so a leak is found by searching the response text.
const KEY_MCQ = "opt-zeta-77";
const KEY_SHORT = "SECRET-SHORT-ANSWER-KEY";
const EXPLAIN_MCQ = "SECRET-EXPLANATION-MCQ";
const EXPLAIN_TF = "SECRET-EXPLANATION-TF";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(auth).mockReset();
});

afterAll(async () => {
  await db.$disconnect();
});

async function setup(opts: { maxAttempts?: number | null; skills?: number } = {}) {
  const { tenant, user: instructor } = await createTenantUser("INSTRUCTOR");
  const student = await createUserInTenant(tenant.id, "STUDENT");
  const { course, lesson } = await createCourse(tenant.id, instructor.id);
  const quiz = await createQuiz(lesson.id, 70);
  await db.quiz.update({
    where: { id: quiz.id },
    data: { maxAttempts: opts.maxAttempts ?? null },
  });
  const [mcq, trueFalse] = await Promise.all([
    db.quizQuestion.create({
      data: {
        quizId: quiz.id,
        question: "Which?",
        type: "MCQ",
        options: [
          { id: KEY_MCQ, text: "Right" },
          { id: "opt-wrong", text: "Wrong" },
        ],
        correctAnswer: KEY_MCQ,
        explanation: EXPLAIN_MCQ,
        order: 0,
      },
    }),
    db.quizQuestion.create({
      data: {
        quizId: quiz.id,
        question: "True?",
        type: "TRUE_FALSE",
        correctAnswer: "true",
        explanation: EXPLAIN_TF,
        order: 1,
      },
    }),
  ]);
  await db.quizQuestion.create({
    data: {
      quizId: quiz.id,
      question: "Explain",
      type: "SHORT_ANSWER",
      correctAnswer: KEY_SHORT,
      order: 2,
    },
  });
  const skills = [];
  for (let i = 0; i < (opts.skills ?? 1); i += 1) {
    const skill = await createSkill(tenant.id);
    await mapCourseSkill(course.id, skill.id);
    skills.push(skill);
  }
  await db.enrollment.create({ data: { userId: student.id, courseId: course.id } });
  return { tenant, student, course, quiz, mcq, trueFalse, skills };
}

const passAnswers = (s: { mcq: { id: string }; trueFalse: { id: string } }) => [
  { questionId: s.mcq.id, answer: KEY_MCQ },
  { questionId: s.trueFalse.id, answer: "true" },
];

function attempt(quizId: string, clerkId: string, answers: unknown[] = []) {
  vi.mocked(auth).mockResolvedValue({ userId: clerkId } as never);
  return POST(
    new Request("http://localhost/api/quizzes/x/attempt", {
      method: "POST",
      body: JSON.stringify({ answers }),
    }),
    { params: Promise.resolve({ quizId }) }
  );
}

const attemptCount = (userId: string, quizId: string) =>
  db.quizAttempt.count({ where: { userId, quizId } });
const evidenceOf = (userId: string) =>
  db.skillEvidence.findMany({ where: { userId, type: "QUIZ_SCORE" } });

function allStrings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) allStrings(item, into);
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      into.push(key);
      allStrings(item, into);
    }
  }
  return into;
}

describe("POST /api/quizzes/[quizId]/attempt — answer key disclosure", () => {
  it("a failed attempt returns no answer key, explanation or per-question correctness", async () => {
    const s = await setup();

    const res = await attempt(s.quiz.id, s.student.clerkId, []);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.isPassed).toBe(false);
    expect(body.answersRevealed).toBe(false);
    expect(body).not.toHaveProperty("correctAnswers");
    const text = JSON.stringify(body);
    for (const secret of [KEY_MCQ, KEY_SHORT, EXPLAIN_MCQ, EXPLAIN_TF]) {
      expect(text).not.toContain(secret);
    }
    for (const field of ["correctAnswer", "explanation", "isCorrect"]) {
      expect(text).not.toContain(field);
    }
    expect(body).toMatchObject({ score: 0, remainingAttempts: null, maxAttempts: null });
  });

  it("nothing in a failed response lets a learner pass the next attempt", async () => {
    const s = await setup({ maxAttempts: 5 });
    const first = await (await attempt(s.quiz.id, s.student.clerkId, [])).json();

    // Every string the failed response contains, offered as an answer to every question.
    const harvested = [...new Set(allStrings(first))];
    const answers = harvested.flatMap((answer) => [
      { questionId: s.mcq.id, answer },
      { questionId: s.trueFalse.id, answer },
    ]);
    const second = await (await attempt(s.quiz.id, s.student.clerkId, answers)).json();

    expect(second.isPassed).toBe(false);
    expect(second.answersRevealed).toBe(false);
  });

  it("a failed attempt on an unlimited quiz never reveals the key, however often it repeats", async () => {
    const s = await setup({ maxAttempts: null });

    for (let i = 0; i < 5; i += 1) {
      const body = await (await attempt(s.quiz.id, s.student.clerkId, [])).json();
      expect(body.answersRevealed).toBe(false);
      expect(JSON.stringify(body)).not.toContain(KEY_MCQ);
    }
  });

  it("a passing attempt returns the answer key and explanations", async () => {
    const s = await setup();

    const body = await (await attempt(s.quiz.id, s.student.clerkId, passAnswers(s))).json();

    expect(body.isPassed).toBe(true);
    expect(body.answersRevealed).toBe(true);
    expect(body.correctAnswers).toHaveLength(3);
    const mcq = body.correctAnswers.find((a: { questionId: string }) => a.questionId === s.mcq.id);
    expect(mcq).toMatchObject({ correctAnswer: KEY_MCQ, explanation: EXPLAIN_MCQ });
  });

  it("failing the LAST allowed attempt releases the key, because it can no longer help", async () => {
    const s = await setup({ maxAttempts: 2 });

    const first = await (await attempt(s.quiz.id, s.student.clerkId, [])).json();
    expect(first).toMatchObject({ answersRevealed: false, remainingAttempts: 1, attemptsUsed: 1 });
    expect(first).not.toHaveProperty("correctAnswers");

    const last = await (await attempt(s.quiz.id, s.student.clerkId, [])).json();
    expect(last).toMatchObject({
      isPassed: false,
      answersRevealed: true,
      remainingAttempts: 0,
      attemptsUsed: 2,
    });
    expect(last.correctAnswers).toHaveLength(3);
  });

  it("reports the remaining budget on every accepted attempt", async () => {
    const s = await setup({ maxAttempts: 3 });

    const a = await (await attempt(s.quiz.id, s.student.clerkId, [])).json();
    const b = await (await attempt(s.quiz.id, s.student.clerkId, [])).json();

    expect([a.remainingAttempts, b.remainingAttempts]).toEqual([2, 1]);
    expect([a.maxAttempts, b.maxAttempts]).toEqual([3, 3]);
  });
});

describe("POST /api/quizzes/[quizId]/attempt — attempt limit", () => {
  it("refuses an attempt past the limit: no grading, no new row, no evidence, no key", async () => {
    const s = await setup({ maxAttempts: 1 });
    expect((await attempt(s.quiz.id, s.student.clerkId, [])).status).toBe(200);

    const res = await attempt(s.quiz.id, s.student.clerkId, passAnswers(s));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body).toEqual({
      error: "Maximum attempts reached",
      attemptsExhausted: true,
      maxAttempts: 1,
      attemptsUsed: 1,
      remainingAttempts: 0,
    });
    expect(await attemptCount(s.student.id, s.quiz.id)).toBe(1);
    expect(await evidenceOf(s.student.id)).toHaveLength(0);
    expect(JSON.stringify(body)).not.toContain(KEY_MCQ);
  });

  it("a learner who has already passed cannot spend further attempts past the limit", async () => {
    const s = await setup({ maxAttempts: 1 });
    expect((await attempt(s.quiz.id, s.student.clerkId, passAnswers(s))).status).toBe(200);

    const res = await attempt(s.quiz.id, s.student.clerkId, passAnswers(s));

    expect(res.status).toBe(403);
    expect(await attemptCount(s.student.id, s.quiz.id)).toBe(1);
  });

  it("counts attempts per learner: another learner keeps a full budget", async () => {
    const s = await setup({ maxAttempts: 1 });
    const other = await createUserInTenant(s.tenant.id, "STUDENT");
    await db.enrollment.create({ data: { userId: other.id, courseId: s.course.id } });
    expect((await attempt(s.quiz.id, s.student.clerkId, [])).status).toBe(200);
    expect((await attempt(s.quiz.id, s.student.clerkId, [])).status).toBe(403);

    const res = await attempt(s.quiz.id, other.clerkId, []);

    expect(res.status).toBe(200);
    expect(await attemptCount(other.id, s.quiz.id)).toBe(1);
  });

  it("null means unlimited: many attempts are all accepted", async () => {
    const s = await setup({ maxAttempts: null });

    for (let i = 0; i < 6; i += 1) {
      expect((await attempt(s.quiz.id, s.student.clerkId, [])).status).toBe(200);
    }

    expect(await attemptCount(s.student.id, s.quiz.id)).toBe(6);
  });

  it("a request rejected as malformed does not use up an attempt", async () => {
    const s = await setup({ maxAttempts: 1 });
    vi.mocked(auth).mockResolvedValue({ userId: s.student.clerkId } as never);

    const bad = await POST(
      new Request("http://localhost/x", {
        method: "POST",
        body: JSON.stringify({ answers: "no" }),
      }),
      { params: Promise.resolve({ quizId: s.quiz.id }) }
    );

    expect(bad.status).toBe(400);
    expect((await attempt(s.quiz.id, s.student.clerkId, [])).status).toBe(200);
  });

  it("existing checks are unchanged: 401, 404 and not enrolled", async () => {
    const s = await setup({ maxAttempts: 1 });
    vi.mocked(auth).mockResolvedValue({ userId: null } as never);
    const anonymous = await POST(new Request("http://localhost/x", { method: "POST" }), {
      params: Promise.resolve({ quizId: s.quiz.id }),
    });
    expect(anonymous.status).toBe(401);

    expect((await attempt("no-such-quiz", s.student.clerkId, [])).status).toBe(404);

    const stranger = await createUserInTenant(s.tenant.id, "STUDENT");
    expect((await attempt(s.quiz.id, stranger.clerkId, [])).status).toBe(403);
    expect(await attemptCount(stranger.id, s.quiz.id)).toBe(0);
  });
});

describe("POST /api/quizzes/[quizId]/attempt — the limit holds under concurrency", () => {
  it.each([
    [1, 3],
    [2, 4],
  ])(
    "maxAttempts %i with %i simultaneous requests accepts no more than the limit",
    async (limit, total) => {
      for (let round = 0; round < 4; round += 1) {
        const s = await setup({ maxAttempts: limit });

        const responses = await Promise.all(
          Array.from({ length: total }, () => attempt(s.quiz.id, s.student.clerkId, []))
        );

        const statuses = responses.map((res) => res.status).sort();
        expect(statuses.filter((status) => status === 200)).toHaveLength(limit);
        expect(statuses.filter((status) => status === 403)).toHaveLength(total - limit);
        expect(await attemptCount(s.student.id, s.quiz.id)).toBe(limit);
      }
    }
  );

  it("a second request must wait on the learner's lock while the first is between count and insert", async () => {
    const s = await setup({ maxAttempts: 1 });
    const real = db.$transaction.bind(db) as unknown as (
      fn: (tx: unknown) => Promise<unknown>,
      options?: unknown
    ) => Promise<unknown>;

    let second: Promise<Response> | undefined;
    let secondSettled = false;
    let settledInsideWindow: boolean | null = null;

    vi.spyOn(db, "$transaction").mockImplementation(((
      fn: (tx: unknown) => Promise<unknown>,
      options?: unknown
    ) =>
      real((tx) => {
        const wrapped = new Proxy(tx as object, {
          get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (prop !== "quizAttempt") return value;
            return new Proxy(value as { count: (...args: unknown[]) => Promise<number> }, {
              get(model, modelProp, modelReceiver) {
                if (modelProp !== "count") return Reflect.get(model, modelProp, modelReceiver);
                return async (...args: unknown[]) => {
                  const counted = await model.count(...args);
                  if (!second) {
                    // The first request has counted (0 attempts) but not yet inserted.
                    // Fire the second now; without the row lock it would count 0 too.
                    second = attempt(s.quiz.id, s.student.clerkId, []).then((res) => {
                      secondSettled = true;
                      return res;
                    });
                    await sleep(400);
                    settledInsideWindow = secondSettled;
                  }
                  return counted;
                };
              },
            });
          },
        });
        return fn(wrapped);
      }, options)) as never);

    const first = await attempt(s.quiz.id, s.student.clerkId, []);
    const secondResponse = await second;
    vi.restoreAllMocks();

    expect(settledInsideWindow).toBe(false);
    expect([first.status, secondResponse?.status].sort()).toEqual([200, 403]);
    expect(await attemptCount(s.student.id, s.quiz.id)).toBe(1);
  });
});

describe("POST /api/quizzes/[quizId]/attempt — quiz evidence", () => {
  it("the first pass writes one QUIZ_SCORE row per skill, keyed by the quiz", async () => {
    const s = await setup({ skills: 1 });

    await attempt(s.quiz.id, s.student.clerkId, passAnswers(s));

    const rows = await evidenceOf(s.student.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceType: "Quiz",
      sourceId: s.quiz.id,
      skillId: s.skills[0].id,
      tenantId: s.tenant.id,
      score: 100,
      verificationStatus: "UNVERIFIED",
    });
  });

  it("repeated passes keep a single row and leave the projected proficiency unchanged", async () => {
    const s = await setup({ skills: 1 });
    await attempt(s.quiz.id, s.student.clerkId, passAnswers(s));
    const after1 = await db.userSkill.findUniqueOrThrow({
      where: { userId_skillId: { userId: s.student.id, skillId: s.skills[0].id } },
    });

    for (let i = 0; i < 3; i += 1) await attempt(s.quiz.id, s.student.clerkId, passAnswers(s));

    expect(await evidenceOf(s.student.id)).toHaveLength(1);
    expect(await attemptCount(s.student.id, s.quiz.id)).toBe(4);
    const after4 = await db.userSkill.findUniqueOrThrow({
      where: { userId_skillId: { userId: s.student.id, skillId: s.skills[0].id } },
    });
    expect(after4.proficiency).toBe(after1.proficiency);
    expect(after4.lastAssessedAt?.getTime()).toBe(after1.lastAssessedAt?.getTime());
  });

  it("a failed attempt writes no evidence", async () => {
    const s = await setup();

    await attempt(s.quiz.id, s.student.clerkId, []);

    expect(await evidenceOf(s.student.id)).toHaveLength(0);
    expect(
      await db.userSkill.findUnique({
        where: { userId_skillId: { userId: s.student.id, skillId: s.skills[0].id } },
      })
    ).toBeNull();
  });

  it("fail then pass leaves exactly one row", async () => {
    const s = await setup();

    await attempt(s.quiz.id, s.student.clerkId, []);
    await attempt(s.quiz.id, s.student.clerkId, passAnswers(s));

    expect(await evidenceOf(s.student.id)).toHaveLength(1);
  });

  it("pass then fail still leaves exactly one row, and the failure does not remove it", async () => {
    const s = await setup();

    await attempt(s.quiz.id, s.student.clerkId, passAnswers(s));
    await attempt(s.quiz.id, s.student.clerkId, []);

    const rows = await evidenceOf(s.student.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBe(100);
  });

  it("with several mapped skills, repeated passes keep exactly one row per skill", async () => {
    const s = await setup({ skills: 3 });

    for (let i = 0; i < 3; i += 1) await attempt(s.quiz.id, s.student.clerkId, passAnswers(s));

    const rows = await evidenceOf(s.student.id);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.skillId)).size).toBe(3);
    expect(rows.every((row) => row.sourceId === s.quiz.id)).toBe(true);
  });

  it("simultaneous passing attempts never duplicate the evidence", async () => {
    for (let round = 0; round < 3; round += 1) {
      const s = await setup({ skills: 2, maxAttempts: null });

      const responses = await Promise.all(
        Array.from({ length: 4 }, () => attempt(s.quiz.id, s.student.clerkId, passAnswers(s)))
      );

      expect(responses.every((res) => res.status === 200)).toBe(true);
      expect(await attemptCount(s.student.id, s.quiz.id)).toBe(4);
      const rows = await evidenceOf(s.student.id);
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row.skillId)).size).toBe(2);
    }
  });

  it("different learners each get their own evidence for the same quiz and skill", async () => {
    const s = await setup();
    const other = await createUserInTenant(s.tenant.id, "STUDENT");
    await db.enrollment.create({ data: { userId: other.id, courseId: s.course.id } });

    await attempt(s.quiz.id, s.student.clerkId, passAnswers(s));
    await attempt(s.quiz.id, other.clerkId, passAnswers(s));

    expect(await evidenceOf(s.student.id)).toHaveLength(1);
    expect(await evidenceOf(other.id)).toHaveLength(1);
  });

  it("a learner who already holds pre-Phase-25 per-attempt evidence gains no second row", async () => {
    const s = await setup({ skills: 1 });
    // Historical shape: two earlier passing attempts, each with its own evidence row.
    const old1 = await db.quizAttempt.create({
      data: { userId: s.student.id, quizId: s.quiz.id, score: 90, isPassed: true },
    });
    const old2 = await db.quizAttempt.create({
      data: { userId: s.student.id, quizId: s.quiz.id, score: 95, isPassed: true },
    });
    for (const old of [old1, old2]) {
      await db.skillEvidence.create({
        data: {
          tenantId: s.tenant.id,
          userId: s.student.id,
          skillId: s.skills[0].id,
          type: "QUIZ_SCORE",
          sourceType: "QuizAttempt",
          sourceId: old.id,
          score: 90,
        },
      });
    }

    await attempt(s.quiz.id, s.student.clerkId, passAnswers(s));

    const rows = await evidenceOf(s.student.id);
    // The two historical rows are untouched and no third row was added.
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.sourceType === "QuizAttempt")).toBe(true);
  });
});
