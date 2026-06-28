"use client";

import Link from "next/link";
import Image from "next/image";
import { motion } from "motion/react";

import { AiBadge } from "@/components/shared/AiBadge";

interface CourseCardCourse {
  id: string;
  title: string;
  thumbnailUrl: string | null;
  instructor: { name: string | null };
  category: string | null;
  price: number;
  currency: string;
  hasAiContent: boolean;
}

interface CourseCardEnrollment {
  status: "ACTIVE" | "COMPLETED" | "REFUNDED";
  completedLessons: number;
  totalLessons: number;
}

interface CourseCardProps {
  course: CourseCardCourse;
  enrollment?: CourseCardEnrollment;
}

export function CourseCard({ course, enrollment }: CourseCardProps) {
  const isEnrolled = !!enrollment;
  const progress =
    enrollment && enrollment.totalLessons > 0
      ? Math.round(
          (enrollment.completedLessons / enrollment.totalLessons) * 100,
        )
      : 0;
  const isCompleted = enrollment?.status === "COMPLETED";

  const priceLabel =
    course.price === 0
      ? "Free"
      : `${course.currency} ${course.price.toLocaleString("en-IN")}`;

  return (
    <motion.div
      whileHover={{ y: -4, boxShadow: "0 12px 28px -6px rgb(0 0 0 / 0.10)" }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="bg-surface-1 border border-border rounded-xl overflow-hidden flex flex-col"
    >
      <Link
        href={`/courses/${course.id}`}
        className="block relative aspect-video bg-surface-3"
      >
        {course.thumbnailUrl ? (
          <Image
            src={course.thumbnailUrl}
            alt={course.title}
            fill
            className="object-cover"
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-3xl">
            📚
          </div>
        )}
        {course.hasAiContent && (
          <div className="absolute top-2 left-2">
            <AiBadge />
          </div>
        )}
      </Link>

      <div className="p-4 flex flex-col gap-2 flex-1">
        <Link href={`/courses/${course.id}`}>
          <h3 className="font-semibold text-sm leading-snug line-clamp-2 text-text-primary hover:text-brand transition-colors">
            {course.title}
          </h3>
        </Link>

        <p className="text-xs text-text-muted">
          {course.instructor.name ?? "Instructor"}
        </p>

        {course.category && (
          <span className="inline-flex self-start items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-brand-light text-brand">
            {course.category}
          </span>
        )}

        <div className="mt-auto pt-3">
          {isEnrolled ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px] text-text-muted">
                <span>{isCompleted ? "Completed" : "In Progress"}</span>
                <span>{progress}%</span>
              </div>
              <div className="h-1.5 bg-surface-3 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${progress}%`,
                    backgroundColor: isCompleted
                      ? "var(--color-success)"
                      : "var(--color-brand)",
                  }}
                />
              </div>
              <Link
                href={`/courses/${course.id}`}
                className="mt-2 flex items-center justify-center w-full py-1.5 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand-dark transition-colors"
              >
                {isCompleted ? "Review" : "Continue"}
              </Link>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-text-primary">
                {priceLabel}
              </span>
              <Link
                href={`/courses/${course.id}`}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-border text-text-secondary hover:border-brand hover:text-brand transition-colors"
              >
                View
              </Link>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
