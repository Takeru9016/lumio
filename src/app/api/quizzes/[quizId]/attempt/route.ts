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

  let scoreable = 0;
  let correct = 0;
  const answerRows: {
    questionId: string;
    answer: string;
    isCorrect: boolean;
  }[] = [];

  for (const q of quiz.questions) {
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

  const score = scoreable === 0 ? 0 : Math.round((correct / scoreable) * 100);
  const isPassed = score >= quiz.passingScore;
  const isPerfect = scoreable > 0 && correct === scoreable;

  const attempt = await db.quizAttempt.create({
    data: {
      userId: dbUser.id,
      quizId: quiz.id,
      score,
      isPassed,
      answers: { create: answerRows },
    },
  });

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

  return NextResponse.json({
    attemptId: attempt.id,
    score,
    isPassed,
    xpAwarded,
    correctAnswers: quiz.questions.map((q) => ({
      questionId: q.id,
      correctAnswer: q.correctAnswer,
      explanation: q.explanation,
    })),
  });
}
