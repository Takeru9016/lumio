import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { generateCertificate } from "@/lib/certificate";
import { db } from "@/lib/db";
import { recordCourseCompletionOutcome } from "@/lib/domain/capability/outcomes";
import { reconcileCourseCompletionEvidence } from "@/lib/domain/capability/reconciliation";
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

  // Capability evidence has its own failure boundary (Phase 24). Its write is
  // idempotent, so a failure here is recorded and rethrown only AFTER the
  // unrelated completion side effects have run — and, symmetrically, a failing
  // XP/certificate/email step can no longer stop the evidence, because the
  // evidence is written first. Retrying the request is always safe: the
  // enrollment gate keeps XP/certificate/training exactly-once, and the loser
  // path below reconciles any evidence a previous attempt did not persist.
  let evidenceFailure: unknown = null;
  let evidenceAttempted = false;
  const guardEvidence = async (write: () => Promise<unknown>) => {
    evidenceAttempted = true;
    try {
      await write();
    } catch (err) {
      evidenceFailure = err;
      console.error(
        `[capability] Course-completion evidence failed for course ${course.id}, user ${dbUser.id} — it is idempotent and is reconciled on the next attempt`,
        err
      );
    }
  };
  const reconcileEvidence = (tenantId: string) =>
    reconcileCourseCompletionEvidence({ tenantId, userId: dbUser.id, courseId: course.id });

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
        // Phase 5 capability loop — tenant-gated like every other V2 write:
        // a FREE-plan user (no tenant) has no capability tracking.
        if (dbUser.tenantId) {
          const tenantId = dbUser.tenantId;
          await guardEvidence(() =>
            recordCourseCompletionOutcome({
              tenantId,
              userId: dbUser.id,
              courseId: course.id,
              enrollmentId: enrollment.id,
              completedAt,
            })
          );
        }

        // Same effects and same failure behavior as before (the first failure
        // is rethrown), but every effect is allowed to finish first. Promise.all
        // would answer on the first rejection and leave the others running
        // after the response, where a retry could overlap them.
        const sideEffects = await Promise.allSettled([
          awardXP(dbUser.id, "COURSE_COMPLETE", XP_EVENTS.COURSE_COMPLETE),
          generateCertificate(dbUser.id, course.id),
          recordMandatoryTrainingCompletion(dbUser.id, course.id),
        ]);
        const failed = sideEffects.find((result) => result.status === "rejected");
        if (failed) throw failed.reason;
        courseXpEarned = XP_EVENTS.COURSE_COMPLETE;
      } else {
        if (dbUser.tenantId) {
          const tenantId = dbUser.tenantId;
          await guardEvidence(() => reconcileEvidence(tenantId));
        }
        await generateCertificate(dbUser.id, course.id);
      }
    }
  }

  // An enrollment that is already COMPLETED keeps its completion evidence
  // even when this request did not itself complete the course (for example a
  // lesson was added after completion, or an earlier attempt failed).
  if (!evidenceAttempted && dbUser.tenantId && enrollment.status === "COMPLETED") {
    const tenantId = dbUser.tenantId;
    await guardEvidence(() => reconcileEvidence(tenantId));
  }

  if (evidenceFailure) throw evidenceFailure;

  return NextResponse.json({
    xpEarned: isFirstCompletion ? XP_EVENTS.LESSON_COMPLETE : 0,
    isFirstCompletion,
    totalCompleted,
    certificateEarned,
    courseCompleted,
    courseXpEarned,
  });
}
