import { auth } from "@clerk/nextjs/server";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";

async function verifyOwnership(courseId: string, sectionId: string, clerkId: string) {
  const [dbUser, course, section] = await Promise.all([
    db.user.findUnique({ where: { clerkId }, select: { id: true } }),
    db.course.findUnique({
      where: { id: courseId },
      select: { id: true, instructorId: true },
    }),
    db.section.findUnique({
      where: { id: sectionId },
      select: { id: true, courseId: true },
    }),
  ]);
  return { dbUser, course, section };
}

const updateSectionSchema = z.object({
  title: z.string().min(1).optional(),
});

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ courseId: string; sectionId: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { courseId, sectionId } = await params;
  const { dbUser, course, section } = await verifyOwnership(courseId, sectionId, userId);

  if (!dbUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!course) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (course.instructorId !== dbUser.id)
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!section || section.courseId !== courseId)
    return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json();
  const parsed = updateSectionSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const updated = await db.section.update({
    where: { id: sectionId },
    data: parsed.data,
  });

  return NextResponse.json(updated);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ courseId: string; sectionId: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { courseId, sectionId } = await params;
  const { dbUser, course, section } = await verifyOwnership(courseId, sectionId, userId);

  if (!dbUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!course) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (course.instructorId !== dbUser.id)
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!section || section.courseId !== courseId)
    return NextResponse.json({ error: "Not found" }, { status: 404 });

  await db.section.delete({ where: { id: sectionId } });

  return new NextResponse(null, { status: 204 });
}
