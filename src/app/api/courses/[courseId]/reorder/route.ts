import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";

const reorderSchema = z.object({
  type: z.enum(["section", "lesson"]),
  items: z.array(z.object({ id: z.string(), order: z.number().int().positive() })).min(1),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ courseId: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { courseId } = await params;

  const [dbUser, course] = await Promise.all([
    db.user.findUnique({ where: { clerkId: userId }, select: { id: true } }),
    db.course.findUnique({ where: { id: courseId }, select: { id: true, instructorId: true } }),
  ]);

  if (!dbUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!course) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (course.instructorId !== dbUser.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json();
  const parsed = reorderSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { type, items } = parsed.data;

  await db.$transaction(
    items.map((item) =>
      type === "section"
        ? db.section.update({ where: { id: item.id, courseId }, data: { order: item.order } })
        : db.lesson.update({ where: { id: item.id }, data: { order: item.order } }),
    ),
  );

  return NextResponse.json({ ok: true });
}
