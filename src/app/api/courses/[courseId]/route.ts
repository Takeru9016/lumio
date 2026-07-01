import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib";

const patchCourseSchema = z.object({
  title: z.string().min(3).max(100).optional(),
  description: z.string().min(10).max(5000).optional().nullable(),
  thumbnailUrl: z.string().url().optional().nullable(),
  category: z.string().optional().nullable(),
  level: z.string().optional().nullable(),
  price: z.number().min(0).optional(),
  currency: z.string().optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ courseId: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { courseId } = await params;

  const [dbUser, course] = await Promise.all([
    db.user.findUnique({ where: { clerkId: userId }, select: { id: true } }),
    db.course.findUnique({
      where: { id: courseId },
      select: { id: true, instructorId: true },
    }),
  ]);

  if (!dbUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!course) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (course.instructorId !== dbUser.id)
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json();
  const parsed = patchCourseSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const updated = await db.course.update({
    where: { id: courseId },
    data: parsed.data,
  });

  revalidatePath(`/courses/${courseId}/edit`);

  return NextResponse.json(updated);
}
