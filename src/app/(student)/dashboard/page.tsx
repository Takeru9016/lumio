import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import { db } from "@/lib/db";
import { getRecommendedLearning } from "@/lib/domain/capability/recommendations";
import { DashboardClient } from "./DashboardClient";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

async function getCourseProgress(userId: string, courseId: string): Promise<number> {
  const [total, completed] = await Promise.all([
    db.lesson.count({
      where: { section: { courseId }, isPublished: true, isArchived: false },
    }),
    db.lessonProgress.count({
      where: {
        userId,
        isCompleted: true,
        lesson: { section: { courseId }, isPublished: true, isArchived: false },
      },
    }),
  ]);
  return total > 0 ? Math.round((completed / total) * 100) : 0;
}

export default async function DashboardPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true, name: true, currentStreak: true, tenantId: true, role: true },
  });
  if (!dbUser) redirect("/onboarding");

  const [activeEnrollments, completedEnrollments] = await Promise.all([
    db.enrollment.findMany({
      where: { userId: dbUser.id, status: "ACTIVE" },
      orderBy: { lastAccessed: "desc" },
      select: {
        courseId: true,
        course: { select: { slug: true, title: true, thumbnailUrl: true } },
      },
    }),
    db.enrollment.findMany({
      where: { userId: dbUser.id, status: "COMPLETED" },
      orderBy: { lastAccessed: "desc" },
      select: {
        courseId: true,
        course: { select: { slug: true, title: true, thumbnailUrl: true } },
      },
    }),
  ]);

  const sevenDaysAgo = new Date(Date.now() - SEVEN_DAYS_MS);

  const [enrollmentsWithProgress, completedWithProgress, xpAgg] = await Promise.all([
    Promise.all(
      activeEnrollments.map(async (e) => ({
        courseSlug: e.course.slug,
        title: e.course.title,
        thumbnailUrl: e.course.thumbnailUrl,
        progress: await getCourseProgress(dbUser.id, e.courseId),
      }))
    ),
    Promise.all(
      completedEnrollments.map(async (e) => ({
        courseSlug: e.course.slug,
        title: e.course.title,
        thumbnailUrl: e.course.thumbnailUrl,
        progress: await getCourseProgress(dbUser.id, e.courseId),
      }))
    ),
    db.xPTransaction.aggregate({
      where: { userId: dbUser.id, createdAt: { gte: sevenDaysAgo } },
      _sum: { amount: true },
    }),
  ]);

  const enrolledCount = enrollmentsWithProgress.length + completedWithProgress.length;
  const avgCompletion =
    enrollmentsWithProgress.length > 0
      ? Math.round(
          enrollmentsWithProgress.reduce((sum, e) => sum + e.progress, 0) /
            enrollmentsWithProgress.length
        )
      : 0;

  const hour = new Date().getHours();
  const timeOfDay = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";

  // Phase 6 capability recommendations — additive, best-effort, tenant-
  // gated like every other V2 capability read (a FREE-plan user with no
  // tenant has no JobRole/UserSkill state to compute gaps from). A failure
  // here must never break the dashboard — omit the section, not the page.
  const recommended = dbUser.tenantId
    ? await getRecommendedLearning({
        userId: dbUser.id,
        clerkId: userId,
        tenantId: dbUser.tenantId,
        role: dbUser.role,
      }).catch(() => ({ recommendations: [] }))
    : { recommendations: [] };

  return (
    <DashboardClient
      firstName={dbUser.name?.split(" ")[0] ?? "there"}
      timeOfDay={timeOfDay}
      currentStreak={dbUser.currentStreak}
      enrolledCount={enrolledCount}
      avgCompletion={avgCompletion}
      xpThisWeek={xpAgg._sum.amount ?? 0}
      continueLearning={enrollmentsWithProgress}
      completedCourses={completedWithProgress}
      recommendations={recommended.recommendations}
    />
  );
}
