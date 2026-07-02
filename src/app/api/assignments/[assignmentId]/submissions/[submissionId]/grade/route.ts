import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";

const bodySchema = z.object({
  score: z.number().int().min(0),
  feedback: z.string().optional().nullable(),
});

export async function PUT(
  req: Request,
  {
    params,
  }: {
    params: Promise<{ assignmentId: string; submissionId: string }>;
  }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { assignmentId, submissionId } = await params;

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true, role: true },
  });
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 404 });
  if (dbUser.role !== "INSTRUCTOR" && dbUser.role !== "SUPER_ADMIN")
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const assignment = await db.assignment.findUnique({
    where: { id: assignmentId },
    select: {
      maxScore: true,
      lesson: {
        select: {
          section: {
            select: { course: { select: { instructorId: true } } },
          },
        },
      },
    },
  });
  if (!assignment) return NextResponse.json({ error: "Assignment not found" }, { status: 404 });
  if (assignment.lesson.section.course.instructorId !== dbUser.id)
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const raw = await req.json();
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success)
    return NextResponse.json(
      { error: "Invalid body", issues: parsed.error.issues },
      { status: 400 }
    );

  const { score, feedback } = parsed.data;
  if (score > assignment.maxScore)
    return NextResponse.json(
      { error: `Score cannot exceed maxScore (${assignment.maxScore})` },
      { status: 400 }
    );

  const existingSubmission = await db.assignmentSubmission.findFirst({
    where: { id: submissionId, assignmentId },
    select: { id: true },
  });
  if (!existingSubmission)
    return NextResponse.json({ error: "Submission not found" }, { status: 404 });

  const submission = await db.assignmentSubmission.update({
    where: { id: submissionId },
    data: {
      score,
      feedback: feedback ?? null,
      status: "GRADED",
      gradedAt: new Date(),
    },
  });

  return NextResponse.json({ submission });
}
