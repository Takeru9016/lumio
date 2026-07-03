import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import { CoursesClient } from "@/components";
import { db } from "@/lib/db";

export default async function OrgCoursesPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { role: true, tenantId: true },
  });
  if (!dbUser || dbUser.role !== "ORG_ADMIN") redirect("/dashboard");
  if (!dbUser.tenantId) redirect("/onboarding");

  const [courses, teams, assignments] = await Promise.all([
    db.course.findMany({
      where: {
        status: "PUBLISHED",
        OR: [{ tenantId: dbUser.tenantId }, { tenantId: null }],
      },
      select: { id: true, title: true, thumbnailUrl: true, category: true, tenantId: true },
      orderBy: { title: "asc" },
    }),
    db.team.findMany({
      where: { tenantId: dbUser.tenantId },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    db.mandatoryTraining.findMany({
      where: { tenantId: dbUser.tenantId },
      select: {
        id: true,
        courseId: true,
        dueDate: true,
        team: { select: { id: true, name: true } },
      },
    }),
  ]);

  const assignmentsByCourse = new Map<string, typeof assignments>();
  for (const a of assignments) {
    const list = assignmentsByCourse.get(a.courseId) ?? [];
    list.push(a);
    assignmentsByCourse.set(a.courseId, list);
  }

  const coursesWithAssignments = courses.map((course) => ({
    ...course,
    isMarketplace: course.tenantId === null,
    assignments: (assignmentsByCourse.get(course.id) ?? []).map((a) => ({
      id: a.id,
      teamName: a.team.name,
      dueDate: a.dueDate,
    })),
  }));

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
      <div>
        <h1 className="text-xl font-semibold font-heading text-text-primary">Courses</h1>
        <p className="text-sm text-text-muted mt-1">
          Assign courses as mandatory training for your teams.
        </p>
      </div>

      <CoursesClient courses={coursesWithAssignments} teams={teams} />
    </div>
  );
}
