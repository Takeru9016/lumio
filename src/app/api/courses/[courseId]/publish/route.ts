import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { db } from "@/lib";

export async function POST(_req: Request, { params }: { params: Promise<{ courseId: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { courseId } = await params;

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true },
  });
  if (!dbUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const course = await db.course.findUnique({
    where: { id: courseId, instructorId: dbUser.id },
    select: {
      id: true,
      title: true,
      description: true,
      thumbnailUrl: true,
      sections: {
        select: {
          id: true,
          title: true,
          lessons: {
            where: { isArchived: false },
            select: { id: true, type: true, videoStatus: true },
          },
        },
      },
    },
  });

  if (!course) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const errors: string[] = [];

  if (!course.title?.trim() || course.title.trim() === "Untitled Course") {
    errors.push("Course title cannot be empty or 'Untitled Course'");
  }

  if (!course.description || course.description.trim().length < 100) {
    errors.push("Course description must be at least 100 characters");
  }

  if (!course.thumbnailUrl) {
    errors.push("A course thumbnail is required");
  }

  if (course.sections.length === 0) {
    errors.push("Add at least one section before publishing");
  } else {
    const emptySections = course.sections.filter((s) => s.lessons.length === 0);
    if (emptySections.length > 0) {
      const names = emptySections.map((s) => `"${s.title}"`).join(", ");
      errors.push(
        `${emptySections.length === 1 ? "Section" : "Sections"} ${names} ${emptySections.length === 1 ? "has" : "have"} no lessons`
      );
    }
  }

  const allLessons = course.sections.flatMap((s) => s.lessons);
  const hasReadyVideo = allLessons.some((l) => l.type === "VIDEO" && l.videoStatus === "READY");
  if (!hasReadyVideo) {
    errors.push("At least one video lesson must be fully processed (READY)");
  }

  if (errors.length > 0) {
    return NextResponse.json({ errors }, { status: 400 });
  }

  const updated = await db.course.update({
    where: { id: courseId },
    data: { status: "PUBLISHED", publishedAt: new Date() },
    select: { id: true, status: true },
  });

  return NextResponse.json(updated);
}
