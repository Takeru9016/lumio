import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { generateCertificate } from "@/lib/certificate";
import { db } from "@/lib/db";
import { updateStreak } from "@/lib/streak";
import { awardXP, XP_EVENTS } from "@/lib/xp";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ courseId: string; lessonId: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { courseId, lessonId } = await params;

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true },
  });
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const [enrollment, lesson] = await Promise.all([
    db.enrollment.findUnique({
      where: { userId_courseId: { userId: dbUser.id, courseId } },
      select: { id: true, status: true },
    }),
    db.lesson.findFirst({
      where: { id: lessonId, section: { courseId } },
      select: { id: true },
    }),
  ]);

  if (!enrollment) return NextResponse.json({ error: "Not enrolled" }, { status: 403 });
  if (!lesson) return NextResponse.json({ error: "Lesson not found" }, { status: 404 });

  const existing = await db.lessonProgress.findUnique({
    where: { userId_lessonId: { userId: dbUser.id, lessonId } },
    select: { isCompleted: true },
  });

  const isFirstCompletion = !existing?.isCompleted;

  if (isFirstCompletion) {
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

    await Promise.all([
      awardXP(dbUser.id, "LESSON_COMPLETE", XP_EVENTS.LESSON_COMPLETE),
      updateStreak(dbUser.id),
    ]);
  }

  const totalCompleted = await db.lessonProgress.count({
    where: {
      userId: dbUser.id,
      isCompleted: true,
      lesson: { section: { courseId } },
    },
  });

  // Always check course completion — a quiz pass can trigger it even when the
  // lesson was already marked complete manually before the quiz was attempted.
  let certificateEarned = false;
  let courseCompleted = false;
  let courseXpEarned = 0;

  const allPublishedLessons = await db.lesson.findMany({
    where: { section: { courseId }, isPublished: true, isArchived: false },
    select: { quiz: { select: { id: true } } },
  });

  const totalLessons = allPublishedLessons.length;

  if (totalLessons > 0 && totalCompleted >= totalLessons) {
    const quizIds = allPublishedLessons.map((l) => l.quiz?.id).filter((id): id is string => !!id);

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
      certificateEarned = true;
      courseCompleted = true;
      if (enrollment.status !== "COMPLETED") {
        await Promise.all([
          db.enrollment.update({
            where: { id: enrollment.id },
            data: { status: "COMPLETED", completedAt: new Date() },
          }),
          awardXP(dbUser.id, "COURSE_COMPLETE", XP_EVENTS.COURSE_COMPLETE),
          generateCertificate(dbUser.id, courseId),
        ]);
        courseXpEarned = XP_EVENTS.COURSE_COMPLETE;
      } else {
        await generateCertificate(dbUser.id, courseId);
      }
    }
  }

  return NextResponse.json({
    xpEarned: isFirstCompletion ? XP_EVENTS.LESSON_COMPLETE : 0,
    isFirstCompletion,
    totalCompleted,
    certificateEarned,
    courseCompleted,
    courseXpEarned,
  });
}
