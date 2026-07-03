import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { db } from "@/lib/db";

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
    where: { slug: courseId, instructorId: dbUser.id },
    select: { id: true, status: true },
  });

  if (!course) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (course.status === "ARCHIVED") {
    return NextResponse.json({ error: "Course is already archived" }, { status: 400 });
  }

  const updated = await db.course.update({
    where: { id: course.id },
    data: { status: "ARCHIVED" },
    select: { id: true, status: true },
  });

  return NextResponse.json(updated);
}
