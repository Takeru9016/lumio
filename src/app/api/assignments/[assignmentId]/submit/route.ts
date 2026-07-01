import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import { awardXP, db, XP_EVENTS } from "@/lib";

const bodySchema = z.object({
  textContent: z.string().optional().nullable(),
  fileUrl: z.string().url().optional().nullable(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ assignmentId: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { assignmentId } = await params;

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true },
  });
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const assignment = await db.assignment.findUnique({
    where: { id: assignmentId },
    select: {
      id: true,
      dueDate: true,
      lesson: {
        select: { section: { select: { courseId: true } } },
      },
    },
  });
  if (!assignment) return NextResponse.json({ error: "Assignment not found" }, { status: 404 });

  const enrollment = await db.enrollment.findUnique({
    where: {
      userId_courseId: {
        userId: dbUser.id,
        courseId: assignment.lesson.section.courseId,
      },
    },
    select: { id: true },
  });
  if (!enrollment) return NextResponse.json({ error: "Not enrolled" }, { status: 403 });

  const existing = await db.assignmentSubmission.findUnique({
    where: { userId_assignmentId: { userId: dbUser.id, assignmentId } },
    select: { id: true, status: true },
  });
  if (existing?.status === "GRADED")
    return NextResponse.json(
      { error: "This submission has been graded and cannot be changed." },
      { status: 409 }
    );

  const raw = await req.json();
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success)
    return NextResponse.json(
      { error: "Invalid body", issues: parsed.error.issues },
      { status: 400 }
    );

  const { textContent, fileUrl } = parsed.data;
  if (!textContent && !fileUrl)
    return NextResponse.json({ error: "Submit at least text content or a file." }, { status: 400 });

  const now = new Date();
  const isLate = assignment.dueDate ? now > assignment.dueDate : false;
  const status = isLate ? ("LATE" as const) : ("SUBMITTED" as const);
  const isFirstSubmission = !existing;

  const submission = await db.assignmentSubmission.upsert({
    where: { userId_assignmentId: { userId: dbUser.id, assignmentId } },
    create: {
      userId: dbUser.id,
      assignmentId,
      textContent: textContent ?? null,
      fileUrl: fileUrl ?? null,
      status,
      submittedAt: now,
    },
    update: {
      textContent: textContent ?? null,
      fileUrl: fileUrl ?? null,
      status,
      submittedAt: now,
    },
  });

  if (isFirstSubmission) {
    await awardXP(dbUser.id, "ASSIGNMENT_SUBMIT", XP_EVENTS.ASSIGNMENT_SUBMIT);
  }

  return NextResponse.json({
    submission,
    xpAwarded: isFirstSubmission ? XP_EVENTS.ASSIGNMENT_SUBMIT : 0,
  });
}
