import { auth } from "@clerk/nextjs/server";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { filterLessonIdsInCourse } from "@/lib/domain/course/contentAuthorization";

const reorderSchema = z.object({
  type: z.enum(["section", "lesson"]),
  items: z.array(z.object({ id: z.string(), order: z.number().int().positive() })).min(1),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ courseId: string }> }
) {
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

  const body = await req.json();
  const parsed = reorderSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { type, items } = parsed.data;

  if (type === "lesson") {
    // Each lesson id is client-supplied: prove it belongs to the course the
    // caller was just authorized for (lesson -> section -> course) before any
    // write. A foreign, cross-tenant or nonexistent id is a uniform 404 — the
    // whole batch is rejected, nothing is partially reordered.
    const requestedIds = [...new Set(items.map((item) => item.id))];
    const ownedIds = await filterLessonIdsInCourse(course.id, requestedIds);
    if (ownedIds.size !== requestedIds.length) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
  }

  await db.$transaction(
    items.map((item) =>
      type === "section"
        ? db.section.update({
            where: { id: item.id, courseId: course.id },
            data: { order: item.order },
          })
        : db.lesson.update({
            where: { id: item.id, section: { courseId: course.id } },
            data: { order: item.order },
          })
    )
  );

  return NextResponse.json({ ok: true });
}
