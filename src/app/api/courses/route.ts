import { auth } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import type { CourseStatus } from "@/generated/prisma/client";

const VALID_STATUSES: CourseStatus[] = ["DRAFT", "PUBLISHED", "ARCHIVED"];

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = req.nextUrl;
  const statusParam = searchParams.get("status");
  const instructorId = searchParams.get("instructorId") ?? undefined;
  const tenantId = searchParams.get("tenantId") ?? undefined;
  const category = searchParams.get("category") ?? undefined;
  const page = Math.max(1, Number(searchParams.get("page") ?? "1"));
  const limit = Math.min(50, Math.max(1, Number(searchParams.get("limit") ?? "12")));

  const status =
    statusParam && VALID_STATUSES.includes(statusParam as CourseStatus)
      ? (statusParam as CourseStatus)
      : undefined;

  const where = {
    ...(status ? { status } : {}),
    ...(instructorId ? { instructorId } : {}),
    ...(tenantId ? { tenantId } : {}),
    ...(category ? { category } : {}),
  };

  const [courses, total] = await Promise.all([
    db.course.findMany({
      where,
      select: {
        id: true,
        title: true,
        description: true,
        thumbnailUrl: true,
        status: true,
        price: true,
        currency: true,
        category: true,
        level: true,
        publishedAt: true,
        createdAt: true,
        instructor: {
          select: { id: true, name: true, avatarUrl: true },
        },
        _count: {
          select: { enrollments: true, sections: true },
        },
        sections: {
          select: {
            _count: { select: { lessons: true } },
            lessons: {
              select: {
                aiSummary: true,
                quiz: { select: { isAiGenerated: true } },
              },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    db.course.count({ where }),
  ]);

  const shaped = courses.map((course) => {
    const lessonCount = course.sections.reduce(
      (sum, s) => sum + s._count.lessons,
      0,
    );
    const hasAiContent = course.sections.some((s) =>
      s.lessons.some(
        (l) => l.aiSummary !== null || l.quiz?.isAiGenerated === true,
      ),
    );
    return {
      id: course.id,
      title: course.title,
      description: course.description,
      thumbnailUrl: course.thumbnailUrl,
      status: course.status,
      price: course.price,
      currency: course.currency,
      category: course.category,
      level: course.level,
      publishedAt: course.publishedAt,
      instructor: course.instructor,
      enrollmentCount: course._count.enrollments,
      sectionCount: course._count.sections,
      lessonCount,
      hasAiContent,
    };
  });

  return Response.json({
    courses: shaped,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  });
}
