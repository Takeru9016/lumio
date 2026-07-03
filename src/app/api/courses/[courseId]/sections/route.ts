import { auth } from "@clerk/nextjs/server";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";

async function getCourseAndUser(courseSlug: string, clerkId: string) {
  const [dbUser, course] = await Promise.all([
    db.user.findUnique({ where: { clerkId }, select: { id: true } }),
    db.course.findUnique({
      where: { slug: courseSlug },
      select: { id: true, instructorId: true },
    }),
  ]);
  return { dbUser, course };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ courseId: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { courseId } = await params;

  const course = await db.course.findUnique({
    where: { slug: courseId },
    select: {
      sections: {
        orderBy: { order: "asc" },
        include: {
          lessons: { orderBy: { order: "asc" } },
        },
      },
    },
  });

  if (!course) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json(course.sections);
}

const createSectionSchema = z.object({
  title: z.string().min(1),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ courseId: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { courseId } = await params;
  const { dbUser, course } = await getCourseAndUser(courseId, userId);

  if (!dbUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!course) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (course.instructorId !== dbUser.id)
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json();
  const parsed = createSectionSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const count = await db.section.count({ where: { courseId: course.id } });

  const section = await db.section.create({
    data: {
      title: parsed.data.title,
      order: count + 1,
      courseId: course.id,
    },
  });

  return NextResponse.json(section, { status: 201 });
}
