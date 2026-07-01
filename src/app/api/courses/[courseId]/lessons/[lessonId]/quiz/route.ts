import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib";

const questionSchema = z.object({
  question: z.string().min(1),
  type: z.enum(["MCQ", "TRUE_FALSE", "SHORT_ANSWER"]),
  options: z
    .array(z.object({ id: z.string(), text: z.string() }))
    .optional()
    .nullable(),
  correctAnswer: z.string().min(1),
  explanation: z.string().optional().nullable(),
  order: z.number().int(),
});

const bodySchema = z.object({
  title: z.string().min(1).default("Quiz"),
  passingScore: z.number().int().min(0).max(100).default(70),
  isAiGenerated: z.boolean().optional(),
  questions: z.array(questionSchema),
});

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ courseId: string; lessonId: string }> },
) {
  const { userId } = await auth();
  if (!userId)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { courseId, lessonId } = await params;

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true },
  });
  if (!dbUser)
    return NextResponse.json({ error: "User not found" }, { status: 404 });

  const lesson = await db.lesson.findFirst({
    where: { id: lessonId, section: { courseId } },
    select: {
      id: true,
      section: { select: { course: { select: { instructorId: true } } } },
    },
  });
  if (!lesson)
    return NextResponse.json({ error: "Lesson not found" }, { status: 404 });
  if (lesson.section.course.instructorId !== dbUser.id)
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const quiz = await db.quiz.findUnique({
    where: { lessonId },
    include: {
      questions: { orderBy: { order: "asc" } },
    },
  });

  return NextResponse.json({ quiz });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ courseId: string; lessonId: string }> },
) {
  const { userId } = await auth();
  if (!userId)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { courseId, lessonId } = await params;

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true },
  });
  if (!dbUser)
    return NextResponse.json({ error: "User not found" }, { status: 404 });

  const lesson = await db.lesson.findFirst({
    where: { id: lessonId, section: { courseId } },
    select: {
      id: true,
      section: { select: { course: { select: { instructorId: true } } } },
    },
  });
  if (!lesson)
    return NextResponse.json({ error: "Lesson not found" }, { status: 404 });
  if (lesson.section.course.instructorId !== dbUser.id)
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const raw = await req.json();
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success)
    return NextResponse.json(
      { error: "Invalid body", issues: parsed.error.issues },
      { status: 400 },
    );

  const { title, passingScore, isAiGenerated, questions } = parsed.data;

  const quiz = await db.quiz.upsert({
    where: { lessonId },
    create: {
      lessonId,
      title,
      passingScore,
      isAiGenerated: isAiGenerated ?? false,
    },
    // Only overwrite the AI flag when the caller sends it, so a manual re-save
    // never clears a quiz's AI-generated provenance.
    update: {
      title,
      passingScore,
      ...(isAiGenerated !== undefined ? { isAiGenerated } : {}),
    },
  });

  await db.quizQuestion.deleteMany({ where: { quizId: quiz.id } });

  if (questions.length > 0) {
    await db.quizQuestion.createMany({
      data: questions.map((q, i) => ({
        quizId: quiz.id,
        question: q.question,
        type: q.type,
        ...(q.options != null ? { options: q.options } : {}),
        correctAnswer: q.correctAnswer,
        explanation: q.explanation ?? null,
        order: q.order ?? i,
      })),
    });
  }

  const updatedQuiz = await db.quiz.findUnique({
    where: { id: quiz.id },
    include: { questions: { orderBy: { order: "asc" } } },
  });

  return NextResponse.json({ quiz: updatedQuiz });
}
