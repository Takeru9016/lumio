import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { recordQuizOutcome } from "@/lib/domain/capability/outcomes";
import { awardXP, XP_EVENTS } from "@/lib/xp";

const bodySchema = z.object({
  answers: z.array(
    z.object({
      questionId: z.string(),
      answer: z.string(),
    })
  ),
});

type QuizQuestionRow = { id: string; type: string; correctAnswer: string };

function gradeAnswers(questions: QuizQuestionRow[], answerMap: Map<string, string>) {
  let scoreable = 0;
  let correct = 0;
  const answerRows: { questionId: string; answer: string; isCorrect: boolean }[] = [];

  for (const q of questions) {
    const studentAnswer = answerMap.get(q.id) ?? "";

    if (q.type === "SHORT_ANSWER") {
      answerRows.push({ questionId: q.id, answer: studentAnswer, isCorrect: false });
      continue;
    }

    scoreable++;
    const isCorrect = studentAnswer === q.correctAnswer;
    if (isCorrect) correct++;
    answerRows.push({ questionId: q.id, answer: studentAnswer, isCorrect });
  }

  return {
    answerRows,
    score: scoreable === 0 ? 0 : Math.round((correct / scoreable) * 100),
    isPerfect: scoreable > 0 && correct === scoreable,
  };
}

export async function POST(req: Request, { params }: { params: Promise<{ quizId: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { quizId } = await params;

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true, tenantId: true },
  });
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const quiz = await db.quiz.findUnique({
    where: { id: quizId },
    select: {
      id: true,
      passingScore: true,
      maxAttempts: true,
      lesson: {
        select: { section: { select: { courseId: true } } },
      },
      questions: {
        select: {
          id: true,
          type: true,
          correctAnswer: true,
          explanation: true,
        },
      },
    },
  });
  if (!quiz) return NextResponse.json({ error: "Quiz not found" }, { status: 404 });

  const courseId = quiz.lesson.section.courseId;

  const enrollment = await db.enrollment.findUnique({
    where: { userId_courseId: { userId: dbUser.id, courseId } },
    select: { id: true },
  });
  if (!enrollment) return NextResponse.json({ error: "Not enrolled" }, { status: 403 });

  const raw = await req.json();
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const { answers } = parsed.data;
  const answerMap = new Map(answers.map((a) => [a.questionId, a.answer]));
  const { maxAttempts } = quiz;

  // The attempt limit is enforced here, not in the client. "Count attempts, then
  // insert" is not safe on its own: two simultaneous requests can both count
  // below the limit and both insert. So a limited quiz takes a row lock on THIS
  // learner's enrollment before counting. Concurrent attempts by the same
  // learner queue on that lock, and under READ COMMITTED each one then counts
  // the attempts the previous one committed — so at most `maxAttempts` are ever
  // accepted. The lock is per learner (a different learner's attempts never
  // wait on it) and is held only for the count and the insert; grading is
  // in-memory and everything else (XP, evidence) runs after it is released. A
  // quiz with no limit has nothing to protect and takes no lock.
  const result = await db.$transaction(async (tx) => {
    let attemptsUsedBefore: number | null = null;

    if (maxAttempts !== null) {
      await tx.$queryRaw`SELECT id FROM "Enrollment" WHERE id = ${enrollment.id} FOR UPDATE`;
      attemptsUsedBefore = await tx.quizAttempt.count({
        where: { userId: dbUser.id, quizId: quiz.id },
      });
      if (attemptsUsedBefore >= maxAttempts) {
        return { exhausted: true as const, attemptsUsed: attemptsUsedBefore };
      }
    }

    const graded = gradeAnswers(quiz.questions, answerMap);
    const isPassed = graded.score >= quiz.passingScore;

    const attempt = await tx.quizAttempt.create({
      data: {
        userId: dbUser.id,
        quizId: quiz.id,
        score: graded.score,
        isPassed,
        answers: { create: graded.answerRows },
      },
    });

    return {
      exhausted: false as const,
      attempt,
      score: graded.score,
      isPassed,
      isPerfect: graded.isPerfect,
      attemptsUsed: attemptsUsedBefore === null ? null : attemptsUsedBefore + 1,
    };
  });

  if (result.exhausted) {
    return NextResponse.json(
      {
        error: "Maximum attempts reached",
        attemptsExhausted: true,
        maxAttempts,
        attemptsUsed: result.attemptsUsed,
        remainingAttempts: 0,
      },
      { status: 403 }
    );
  }

  const { attempt, score, isPassed, isPerfect, attemptsUsed } = result;
  const remainingAttempts =
    maxAttempts === null || attemptsUsed === null ? null : Math.max(0, maxAttempts - attemptsUsed);

  let xpAwarded = 0;
  if (isPassed) {
    const event = isPerfect ? "QUIZ_PERFECT" : "QUIZ_PASS";
    xpAwarded = XP_EVENTS[event];
    await awardXP(dbUser.id, event, xpAwarded);
  }

  // Phase 5 capability loop — additive, best-effort at this boundary (see
  // src/lib/domain/capability/outcomes.ts): never throws, never affects
  // this response. Tenant-gated like every other V2 write.
  if (dbUser.tenantId) {
    await recordQuizOutcome({
      tenantId: dbUser.tenantId,
      userId: dbUser.id,
      quizId: quiz.id,
      attemptId: attempt.id,
      score,
      isPassed,
      occurredAt: attempt.completedAt,
    });
  }

  // The answer key is only ever released when it can no longer help the learner
  // pass: after a passing attempt, or once the attempt budget is spent. A failed
  // attempt with attempts left (or on an unlimited quiz) gets the result and the
  // remaining budget, nothing that reveals an answer — not correctAnswer, not the
  // explanation, and no per-question correctness. The response is authoritative;
  // nothing hidden is sent to the client.
  const answersRevealed = isPassed || remainingAttempts === 0;

  return NextResponse.json({
    attemptId: attempt.id,
    score,
    isPassed,
    xpAwarded,
    maxAttempts,
    attemptsUsed,
    remainingAttempts,
    answersRevealed,
    ...(answersRevealed
      ? {
          correctAnswers: quiz.questions.map((q) => ({
            questionId: q.id,
            correctAnswer: q.correctAnswer,
            explanation: q.explanation,
          })),
        }
      : {}),
  });
}
