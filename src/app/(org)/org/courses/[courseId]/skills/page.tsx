import { auth } from "@clerk/nextjs/server";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { CourseSkillsPanel } from "@/components";

import { db } from "@/lib/db";

interface OrgCourseSkillsPageProps {
  params: Promise<{ courseId: string }>;
}

/**
 * The minimum ORG_ADMIN entry point onto CourseSkill management (Phase 22
 * locked contract §"ORGANIZATION ADMIN ACCESS") — not a new dashboard, just
 * this one narrow page reusing the same CourseSkillsPanel and the same
 * /api/courses/[courseId]/skills routes the instructor page uses. The
 * (org)/layout.tsx route-group layout already redirects non-ORG_ADMIN users
 * before this renders; the tenant scoping below is the actual authorization
 * boundary, mirrored again server-side inside courseSkillManagement.ts.
 */
export default async function OrgCourseSkillsPage({ params }: OrgCourseSkillsPageProps) {
  const { courseId } = await params;
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { role: true, tenantId: true },
  });
  if (!dbUser || dbUser.role !== "ORG_ADMIN") redirect("/dashboard");
  if (!dbUser.tenantId) redirect("/onboarding");

  const course = await db.course.findFirst({
    where: { slug: courseId, tenantId: dbUser.tenantId },
    select: { slug: true, title: true },
  });

  if (!course) notFound();

  return (
    <div className="max-w-2xl mx-auto px-6 py-8">
      <div className="mb-6">
        <Link
          href="/org/courses"
          className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary transition-colors mb-4"
        >
          <ArrowLeft size={14} />
          Back to courses
        </Link>
        <h1 className="text-xl font-semibold font-heading text-text-primary">
          Skills / Capability
        </h1>
        <p className="text-sm text-text-muted mt-1">{course.title}</p>
      </div>

      <div className="bg-white rounded-xl border border-border p-6">
        <CourseSkillsPanel courseId={course.slug} />
      </div>
    </div>
  );
}
