import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";

async function resolveLessonOwnership(courseId: string, lessonId: string, clerkId: string) {
  const [dbUser, course, lesson] = await Promise.all([
    db.user.findUnique({ where: { clerkId }, select: { id: true } }),
    db.course.findUnique({ where: { id: courseId }, select: { id: true, instructorId: true } }),
    db.lesson.findUnique({
      where: { id: lessonId },
      select: { id: true, sectionId: true, section: { select: { courseId: true } } },
    }),
  ]);
  return { dbUser, course, lesson };
}

const updateLessonSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  textContent: z.string().optional(),
  isPublished: z.boolean().optional(),
});

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ courseId: string; sectionId: string; lessonId: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { courseId, sectionId, lessonId } = await params;
  const { dbUser, course, lesson } = await resolveLessonOwnership(courseId, lessonId, userId);

  if (!dbUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!course) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (course.instructorId !== dbUser.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!lesson || lesson.sectionId !== sectionId || lesson.section.courseId !== courseId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await req.json();
  const parsed = updateLessonSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const updated = await db.lesson.update({
    where: { id: lessonId },
    data: parsed.data,
  });

  return NextResponse.json(updated);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ courseId: string; sectionId: string; lessonId: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { courseId, sectionId, lessonId } = await params;
  const { dbUser, course, lesson } = await resolveLessonOwnership(courseId, lessonId, userId);

  if (!dbUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!course) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (course.instructorId !== dbUser.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!lesson || lesson.sectionId !== sectionId || lesson.section.courseId !== courseId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await db.lesson.delete({ where: { id: lessonId } });

  return new NextResponse(null, { status: 204 });
}
