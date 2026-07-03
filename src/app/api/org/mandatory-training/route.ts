import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { db } from "@/lib/db";

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true, role: true, tenantId: true },
  });
  if (!dbUser || dbUser.role !== "ORG_ADMIN" || !dbUser.tenantId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { courseId, teamId, dueDate } = await req.json();
  if (
    typeof courseId !== "string" ||
    typeof teamId !== "string" ||
    typeof dueDate !== "string" ||
    Number.isNaN(Date.parse(dueDate))
  ) {
    return NextResponse.json(
      { error: "courseId, teamId, and dueDate are required" },
      { status: 400 }
    );
  }

  const [course, team] = await Promise.all([
    db.course.findUnique({ where: { id: courseId }, select: { tenantId: true } }),
    db.team.findUnique({ where: { id: teamId }, select: { tenantId: true } }),
  ]);

  if (!team || team.tenantId !== dbUser.tenantId) {
    return NextResponse.json({ error: "Team not found" }, { status: 404 });
  }
  if (!course || (course.tenantId !== null && course.tenantId !== dbUser.tenantId)) {
    return NextResponse.json(
      { error: "Course not available to your organization" },
      { status: 404 }
    );
  }

  const training = await db.mandatoryTraining.upsert({
    where: { courseId_teamId: { courseId, teamId } },
    create: { courseId, teamId, tenantId: dbUser.tenantId, dueDate: new Date(dueDate) },
    update: { dueDate: new Date(dueDate), completedCount: 0 },
    select: {
      id: true,
      dueDate: true,
      completedCount: true,
      team: { select: { name: true } },
    },
  });

  return NextResponse.json(training, { status: 201 });
}
