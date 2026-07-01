import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib";

const bodySchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  dueDate: z.string().datetime().optional().nullable(),
  maxScore: z.number().int().min(1).max(1000).default(100),
});

async function getInstructorLesson(clerkId: string, courseId: string, lessonId: string) {
  const dbUser = await db.user.findUnique({
    where: { clerkId },
    select: { id: true },
  });
  if (!dbUser) return null;

  const lesson = await db.lesson.findFirst({
    where: { id: lessonId, section: { courseId } },
    select: {
      id: true,
      section: { select: { course: { select: { instructorId: true } } } },
    },
  });
  if (!lesson) return null;
  if (lesson.section.course.instructorId !== dbUser.id) return null;

  return { dbUserId: dbUser.id, lesson };
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ courseId: string; lessonId: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { courseId, lessonId } = await params;

  const ctx = await getInstructorLesson(userId, courseId, lessonId);
  if (!ctx) return NextResponse.json({ error: "Not found or forbidden" }, { status: 404 });

  const assignment = await db.assignment.findUnique({ where: { lessonId } });

  return NextResponse.json({ assignment });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ courseId: string; lessonId: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { courseId, lessonId } = await params;

  const ctx = await getInstructorLesson(userId, courseId, lessonId);
  if (!ctx) return NextResponse.json({ error: "Not found or forbidden" }, { status: 404 });

  const raw = await req.json();
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success)
    return NextResponse.json(
      { error: "Invalid body", issues: parsed.error.issues },
      { status: 400 }
    );

  const { title, description, dueDate, maxScore } = parsed.data;

  const assignment = await db.assignment.upsert({
    where: { lessonId },
    create: {
      lessonId,
      title,
      description,
      dueDate: dueDate ? new Date(dueDate) : null,
      maxScore,
    },
    update: {
      title,
      description,
      dueDate: dueDate ? new Date(dueDate) : null,
      maxScore,
    },
  });

  return NextResponse.json({ assignment });
}
