import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";

import { db } from "@/lib/db";
import { resend } from "@/lib/resend";

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true, role: true, tenantId: true },
  });

  if (!dbUser || dbUser.role !== "ORG_ADMIN" || !dbUser.tenantId) {
    return Response.json({ error: "Only org admins can send nudges" }, { status: 403 });
  }

  const { trainingId } = await req.json();
  if (typeof trainingId !== "string") {
    return Response.json({ error: "trainingId is required" }, { status: 400 });
  }

  const training = await db.mandatoryTraining.findUnique({
    where: { id: trainingId },
    select: {
      tenantId: true,
      dueDate: true,
      teamId: true,
      courseId: true,
      course: { select: { title: true } },
    },
  });

  if (!training || training.tenantId !== dbUser.tenantId) {
    return Response.json({ error: "Training not found" }, { status: 404 });
  }

  const teamMembers = await db.teamMember.findMany({
    where: { teamId: training.teamId, user: { deletedAt: null } },
    select: { user: { select: { id: true, email: true, name: true } } },
  });

  const completedUserIds = new Set(
    (
      await db.enrollment.findMany({
        where: {
          userId: { in: teamMembers.map((m) => m.user.id) },
          courseId: training.courseId,
          status: "COMPLETED",
        },
        select: { userId: true },
      })
    ).map((e) => e.userId)
  );

  const overdueMembers = teamMembers.map((m) => m.user).filter((u) => !completedUserIds.has(u.id));

  const dueDateLabel = training.dueDate.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  await Promise.all(
    overdueMembers.map((member) =>
      resend.emails
        .send({
          from: "Lumio <hello@lumio.io>",
          to: member.email,
          subject: `Reminder: "${training.course.title}" is due ${dueDateLabel}`,
          html: `<p>Hi ${member.name ?? "there"},</p><p><strong>${training.course.title}</strong> is a mandatory training that was due <strong>${dueDateLabel}</strong>. Please complete it as soon as possible.</p><p>— The Lumio Team</p>`,
        })
        .catch(() => {})
    )
  );

  return Response.json({ sent: overdueMembers.length });
}
