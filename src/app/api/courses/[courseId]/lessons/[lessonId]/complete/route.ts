import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { db } from "@/lib";

const XP_PER_LESSON = 10;

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
    });
  }

  await Promise.all([
    db.lessonProgress.upsert({
      where: { userId_lessonId: { userId: dbUser.id, lessonId } },
      create: {
        userId: dbUser.id,
        lessonId,
        isCompleted: true,
        completedAt: new Date(),
        watchedSecs: 0,
      },
      update: { isCompleted: true, completedAt: new Date() },
    }),
    db.user.update({
      where: { id: dbUser.id },
      data: { xpTotal: { increment: XP_PER_LESSON } },
    }),
  ]);

  const totalCompleted = await db.lessonProgress.count({
    where: {
      userId: dbUser.id,
      isCompleted: true,
      lesson: { section: { courseId } },
    },
  });

  return NextResponse.json({
    xpEarned: XP_PER_LESSON,
    isFirstCompletion: true,
    totalCompleted,
  });
}
