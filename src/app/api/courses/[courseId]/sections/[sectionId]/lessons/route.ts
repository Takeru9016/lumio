import { auth } from "@clerk/nextjs/server";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { LessonType } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { generateUniqueLessonSlug } from "@/lib/slug";

async function resolveSectionOwnership(courseSlug: string, sectionId: string, clerkId: string) {
  const [dbUser, course, section] = await Promise.all([
    db.user.findUnique({ where: { clerkId }, select: { id: true } }),
    db.course.findUnique({
      where: { slug: courseSlug },
      select: { id: true, instructorId: true },
    }),
    db.section.findUnique({
      where: { id: sectionId },
      select: { id: true, courseId: true },
    }),
  ]);
  return { dbUser, course, section };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ courseId: string; sectionId: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { courseId, sectionId } = await params;

  const course = await db.course.findUnique({ where: { slug: courseId }, select: { id: true } });
  if (!course) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const section = await db.section.findUnique({
    where: { id: sectionId, courseId: course.id },
    include: { lessons: { orderBy: { order: "asc" } } },
  });

  if (!section) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json(section.lessons);
}

const createLessonSchema = z.object({
  title: z.string().min(1),
  type: z.enum(["VIDEO", "TEXT", "QUIZ", "ASSIGNMENT"]),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ courseId: string; sectionId: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { courseId, sectionId } = await params;
  const { dbUser, course, section } = await resolveSectionOwnership(courseId, sectionId, userId);

  if (!dbUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!course) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (course.instructorId !== dbUser.id)
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!section || section.courseId !== course.id)
    return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json();
  const parsed = createLessonSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const [count, slug] = await Promise.all([
    db.lesson.count({ where: { sectionId } }),
    generateUniqueLessonSlug(parsed.data.title, course.id),
  ]);

  const lesson = await db.lesson.create({
    data: {
      title: parsed.data.title,
      slug,
      type: parsed.data.type as LessonType,
      order: count + 1,
      sectionId,
    },
  });

  return NextResponse.json(lesson, { status: 201 });
}
