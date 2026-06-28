import { auth } from "@clerk/nextjs/server";
import { redirect, notFound } from "next/navigation";
import { db } from "@/lib/db";
import { CourseSettingsForm } from "@/components/course/CourseSettingsForm";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

interface CourseSettingsPageProps {
  params: Promise<{ courseId: string }>;
}

export default async function CourseSettingsPage({ params }: CourseSettingsPageProps) {
  const { courseId } = await params;
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true },
  });
  if (!dbUser) redirect("/sign-in");

  const course = await db.course.findUnique({
    where: { id: courseId, instructorId: dbUser.id },
    select: {
      id: true,
      title: true,
      description: true,
      thumbnailUrl: true,
      category: true,
      level: true,
      price: true,
      currency: true,
    },
  });

  if (!course) notFound();

  return (
    <div className="max-w-2xl mx-auto px-6 py-8">
      <div className="mb-6">
        <Link
          href={`/courses/${courseId}/edit`}
          className="inline-flex items-center gap-1.5 text-sm text-(--color-text-muted) hover:text-(--color-text-primary) transition-colors mb-4"
        >
          <ArrowLeft size={14} />
          Back to editor
        </Link>
        <h1 className="text-xl font-semibold font-heading text-(--color-text-primary)">
          Course settings
        </h1>
        <p className="text-sm text-(--color-text-muted) mt-1">{course.title}</p>
      </div>

      <div className="bg-white rounded-xl border border-(--color-border) p-6">
        <CourseSettingsForm courseId={course.id} initialData={course} />
      </div>
    </div>
  );
}
