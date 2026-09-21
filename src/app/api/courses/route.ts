import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { assertCanCreateCourse, CourseAuthorizationError } from "@/lib/domain/course/authorization";
import { generateUniqueCourseSlug } from "@/lib/slug";

const createCourseSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  thumbnailUrl: z.string().optional(),
  category: z.string().optional(),
  level: z.enum(["BEGINNER", "INTERMEDIATE", "ADVANCED"]).optional(),
  price: z.number().min(0).optional(),
  currency: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true, role: true, plan: true, tenantId: true },
  });
  if (!user) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    await assertCanCreateCourse(user.id);
  } catch (err) {
    if (err instanceof CourseAuthorizationError) {
      return Response.json(
        { error: err.message, upgradeRequired: err.upgradeRequired },
        { status: err.status }
      );
    }
    throw err;
  }

  const body = await req.json();
  const parsed = createCourseSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { title, description, thumbnailUrl, category, level, price, currency } = parsed.data;
  const slug = await generateUniqueCourseSlug(title);

  const course = await db.course.create({
    data: {
      title,
      slug,
      description,
      thumbnailUrl,
      category,
      level,
      price: price ?? 0,
      currency: currency ?? "INR",
      instructorId: user.id,
      // From the authenticated user's own row, never the request body (the
      // schema above does not accept it). A solo instructor has no tenant, so
      // their course stays tenantless, as before.
      tenantId: user.tenantId,
    },
  });

  return Response.json(course, { status: 201 });
}
