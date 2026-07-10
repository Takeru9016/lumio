"use client";

import { BookOpen, ChevronDown, Sparkles, TrendingUp, Zap } from "lucide-react";
import { motion } from "motion/react";
import Image from "next/image";
import Link from "next/link";
import { useState } from "react";

import { EmptyState } from "@/components";

interface ContinueLearningItem {
  courseSlug: string;
  title: string;
  thumbnailUrl: string | null;
  progress: number;
}

interface DashboardClientProps {
  firstName: string;
  timeOfDay: "morning" | "afternoon" | "evening";
  currentStreak: number;
  enrolledCount: number;
  avgCompletion: number;
  xpThisWeek: number;
  continueLearning: ContinueLearningItem[];
  completedCourses: ContinueLearningItem[];
}

const containerVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.08 } },
};

const itemVariants = {
  hidden: { opacity: 0, y: 6 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.15, ease: "easeOut" as const } },
};

export function DashboardClient({
  firstName,
  timeOfDay,
  currentStreak,
  enrolledCount,
  avgCompletion,
  xpThisWeek,
  continueLearning,
  completedCourses,
}: DashboardClientProps) {
  const [showCompleted, setShowCompleted] = useState(false);

  const stats = [
    { icon: BookOpen, label: "Enrolled courses", value: enrolledCount.toString() },
    { icon: TrendingUp, label: "Avg completion", value: `${avgCompletion}%` },
    { icon: Zap, label: "XP this week", value: xpThisWeek.toString() },
  ];

  return (
    <motion.div
      variants={containerVariants}
      initial="hidden"
      animate="visible"
      className="p-6 max-w-5xl mx-auto space-y-6"
    >
      <motion.div variants={itemVariants} className="flex items-center gap-3">
        <h1
          className="text-xl font-bold text-text-primary"
          style={{ fontFamily: "var(--font-heading)" }}
        >
          Good {timeOfDay}, {firstName}
        </h1>
        {currentStreak >= 2 && (
          <span className="text-sm font-medium text-text-muted">🔥 {currentStreak}-day streak</span>
        )}
      </motion.div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {stats.map((stat) => (
          <motion.div
            key={stat.label}
            variants={itemVariants}
            className="bg-surface-1 border border-border rounded-lg p-4 shadow-sm"
          >
            <div className="flex items-center gap-2 text-text-muted mb-2">
              <stat.icon size={15} />
              <span className="text-xs font-medium">{stat.label}</span>
            </div>
            <p
              className="text-2xl font-bold text-text-primary"
              style={{ fontFamily: "var(--font-heading)" }}
            >
              {stat.value}
            </p>
          </motion.div>
        ))}
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-text-primary">Continue learning</h2>

        {continueLearning.length === 0 ? (
          <motion.div
            variants={itemVariants}
            className="bg-surface-1 border border-border rounded-lg"
          >
            <EmptyState
              icon="📚"
              title="No courses in progress"
              description="Enroll in a course to start tracking your progress here."
              ctaLabel="Explore Courses →"
              ctaHref="/courses"
            />
          </motion.div>
        ) : (
          continueLearning.map((course) => (
            <motion.div key={course.courseSlug} variants={itemVariants}>
              <Link
                href={`/courses/${course.courseSlug}`}
                className="flex items-center gap-4 bg-surface-1 border border-border rounded-lg p-4 shadow-sm hover:border-border-strong transition-colors"
              >
                <div className="relative h-12 w-20 shrink-0 rounded-md overflow-hidden bg-surface-3 flex items-center justify-center text-lg">
                  {course.thumbnailUrl ? (
                    <Image
                      src={course.thumbnailUrl}
                      alt={course.title}
                      fill
                      className="object-cover"
                      sizes="80px"
                    />
                  ) : (
                    "📚"
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-text-primary truncate">{course.title}</p>
                  <div className="flex items-center gap-2 mt-1.5">
                    <div className="h-1.5 flex-1 rounded-full bg-surface-3 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-brand transition-all"
                        style={{ width: `${course.progress}%` }}
                      />
                    </div>
                    <span className="text-xs text-text-muted shrink-0">{course.progress}%</span>
                  </div>
                </div>
              </Link>
            </motion.div>
          ))
        )}
      </div>

      {completedCourses.length > 0 && (
        <motion.div variants={itemVariants} className="space-y-3">
          <button
            type="button"
            onClick={() => setShowCompleted((v) => !v)}
            className="flex items-center gap-1.5 text-sm font-semibold text-text-primary"
          >
            Completed ({completedCourses.length})
            <ChevronDown
              size={15}
              className={`text-text-muted transition-transform ${showCompleted ? "rotate-180" : ""}`}
            />
          </button>

          {showCompleted && (
            <div className="space-y-3">
              {completedCourses.map((course) => (
                <Link
                  key={course.courseSlug}
                  href={`/courses/${course.courseSlug}`}
                  className="flex items-center gap-4 bg-surface-1 border border-border rounded-lg p-4 shadow-sm hover:border-border-strong transition-colors"
                >
                  <div className="relative h-12 w-20 shrink-0 rounded-md overflow-hidden bg-surface-3 flex items-center justify-center text-lg">
                    {course.thumbnailUrl ? (
                      <Image
                        src={course.thumbnailUrl}
                        alt={course.title}
                        fill
                        className="object-cover"
                        sizes="80px"
                      />
                    ) : (
                      "📚"
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-text-primary truncate">
                      {course.title}
                    </p>
                    <span className="text-xs text-text-muted">Completed</span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </motion.div>
      )}

      <motion.div variants={itemVariants}>
        <Link
          href="/learning-path"
          className="flex items-center gap-3 bg-ai-bg border border-ai-border rounded-lg p-4 hover:opacity-90 transition-opacity"
        >
          <span className="text-xl text-ai">✦</span>
          <div>
            <p className="text-sm font-semibold text-ai flex items-center gap-1.5">
              <Sparkles size={13} /> AI Learning Path
            </p>
            <p className="text-xs text-text-muted mt-0.5">
              Get personalised lesson recommendations based on your progress
            </p>
          </div>
        </Link>
      </motion.div>
    </motion.div>
  );
}
