import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { getCourseAnalytics } from "@/lib/course-analytics";
import { db } from "@/lib/db";

export async function GET(_req: Request, { params }: { params: Promise<{ courseId: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { courseId } = await params;

  const [dbUser, course] = await Promise.all([
    db.user.findUnique({ where: { clerkId: userId }, select: { id: true } }),
    db.course.findUnique({
      where: { slug: courseId },
      select: { id: true, instructorId: true },
    }),
  ]);

  if (!dbUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!course) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (course.instructorId !== dbUser.id)
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const analytics = await getCourseAnalytics(course.id);

  return NextResponse.json(analytics);
}
