import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { db, awardXP, updateStreak, XP_EVENTS, generateCertificate } from "@/lib";

export async function POST(
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

  const [enrollment, lesson] = await Promise.all([
    db.enrollment.findUnique({
      where: { userId_courseId: { userId: dbUser.id, courseId } },
      select: { id: true },
    }),
    db.lesson.findFirst({
      where: { id: lessonId, section: { courseId } },
      select: { id: true },
    }),
  ]);

  if (!enrollment)
    return NextResponse.json({ error: "Not enrolled" }, { status: 403 });
  if (!lesson)
    return NextResponse.json({ error: "Lesson not found" }, { status: 404 });

  const existing = await db.lessonProgress.findUnique({
    where: { userId_lessonId: { userId: dbUser.id, lessonId } },
    select: { isCompleted: true },
  });

  if (existing?.isCompleted) {
    const totalCompleted = await db.lessonProgress.count({
      where: {
        userId: dbUser.id,
        isCompleted: true,
        lesson: { section: { courseId } },
      },
    });
    return NextResponse.json({
      xpEarned: 0,
      isFirstCompletion: false,
      totalCompleted,
      certificateEarned: false,
    });
  }

  await db.lessonProgress.upsert({
    where: { userId_lessonId: { userId: dbUser.id, lessonId } },
    create: {
      userId: dbUser.id,
      lessonId,
      isCompleted: true,
      completedAt: new Date(),
      watchedSecs: 0,
    },
    update: { isCompleted: true, completedAt: new Date() },
  });

  const [, totalCompleted] = await Promise.all([
    Promise.all([
      awardXP(dbUser.id, "LESSON_COMPLETE", XP_EVENTS.LESSON_COMPLETE),
      updateStreak(dbUser.id),
    ]),
    db.lessonProgress.count({
      where: {
        userId: dbUser.id,
        isCompleted: true,
        lesson: { section: { courseId } },
      },
    }),
  ]);

  // Check if the full course is now complete
  let certificateEarned = false;

  const allPublishedLessons = await db.lesson.findMany({
    where: { section: { courseId }, isPublished: true },
    select: { quiz: { select: { id: true } } },
  });

  const totalLessons = allPublishedLessons.length;

  if (totalLessons > 0 && totalCompleted >= totalLessons) {
    const quizIds = allPublishedLessons
      .map((l) => l.quiz?.id)
      .filter((id): id is string => !!id);

    let allQuizzesPassed = true;
    if (quizIds.length > 0) {
      const passedDistinct = await db.quizAttempt.findMany({
        where: { userId: dbUser.id, quizId: { in: quizIds }, isPassed: true },
        distinct: ["quizId"],
        select: { quizId: true },
      });
      allQuizzesPassed = passedDistinct.length >= quizIds.length;
    }

    if (allQuizzesPassed) {
      await generateCertificate(dbUser.id, courseId);
      certificateEarned = true;
    }
  }

  return NextResponse.json({
    xpEarned: XP_EVENTS.LESSON_COMPLETE,
    isFirstCompletion: true,
    totalCompleted,
    certificateEarned,
  });
}
