import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { generateCertificate } from "@/lib/certificate";
import { db } from "@/lib/db";
import { recordCourseCompletionOutcome } from "@/lib/domain/capability/outcomes";
import { recordMandatoryTrainingCompletion } from "@/lib/mandatory-training";
import { updateStreak } from "@/lib/streak";
import { awardXP, XP_EVENTS } from "@/lib/xp";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ courseId: string; lessonId: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { courseId, lessonId } = await params;

  const [dbUser, course] = await Promise.all([
    db.user.findUnique({ where: { clerkId: userId }, select: { id: true, tenantId: true } }),
    db.course.findUnique({ where: { slug: courseId }, select: { id: true } }),
  ]);
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 404 });
  if (!course) return NextResponse.json({ error: "Course not found" }, { status: 404 });

  const [enrollment, lesson] = await Promise.all([
    db.enrollment.findUnique({
      where: { userId_courseId: { userId: dbUser.id, courseId: course.id } },
      select: { id: true, status: true },
    }),
    db.lesson.findFirst({
      where: { id: lessonId, section: { courseId: course.id } },
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
      lesson: { section: { courseId: course.id } },
    },
  });

  // Always check course completion — a quiz pass can trigger it even when the
  // lesson was already marked complete manually before the quiz was attempted.
  let certificateEarned = false;
  let courseCompleted = false;
  let courseXpEarned = 0;

  const allPublishedLessons = await db.lesson.findMany({
    where: { section: { courseId: course.id }, isPublished: true, isArchived: false },
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

      // Atomic conditional transition is the concurrency gate: only the
      // request whose UPDATE actually flips status away from COMPLETED may
      // run the one-time completion side effects. A plain status !== check
      // read from the pre-fetched `enrollment` snapshot above cannot prevent
      // two concurrent requests both seeing NOT COMPLETED and both racing
      // into the one-time branch (Phase 5 final contract audit finding).
      const completedAt = new Date();
      const { count } = await db.enrollment.updateMany({
        where: { id: enrollment.id, status: { not: "COMPLETED" } },
        data: { status: "COMPLETED", completedAt },
      });
      const wonCompletionTransition = count === 1;

      if (wonCompletionTransition) {
        await Promise.all([
          awardXP(dbUser.id, "COURSE_COMPLETE", XP_EVENTS.COURSE_COMPLETE),
          generateCertificate(dbUser.id, course.id),
          recordMandatoryTrainingCompletion(dbUser.id, course.id),
        ]);
        courseXpEarned = XP_EVENTS.COURSE_COMPLETE;

        // Phase 5 capability loop — additive, best-effort at this boundary
        // (see src/lib/domain/capability/outcomes.ts): never throws, never
        // affects this response. Tenant-gated like every other V2 write —
        // a FREE-plan user (no tenant) has no capability tracking.
        if (dbUser.tenantId) {
          await recordCourseCompletionOutcome({
            tenantId: dbUser.tenantId,
            userId: dbUser.id,
            courseId: course.id,
            enrollmentId: enrollment.id,
            completedAt,
          });
        }
      } else {
        await generateCertificate(dbUser.id, course.id);
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
