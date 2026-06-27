"use client";

import Link from "next/link";
import { CheckCircle2, Circle, PlayCircle, FileText, HelpCircle, ClipboardList } from "lucide-react";
import type { LessonType } from "@/generated/prisma/enums";

export interface SidebarLesson {
  id: string;
  title: string;
  type: LessonType;
  isAiQuiz: boolean;
}

export interface SidebarSection {
  id: string;
  title: string;
  lessons: SidebarLesson[];
}

interface LessonSidebarProps {
  courseId: string;
  currentLessonId: string;
  sections: SidebarSection[];
  completedIds: Set<string>;
}

const TYPE_ICONS: Record<LessonType, React.ReactNode> = {
  VIDEO: <PlayCircle size={13} />,
  TEXT: <FileText size={13} />,
  QUIZ: <HelpCircle size={13} />,
  ASSIGNMENT: <ClipboardList size={13} />,
};

export function LessonSidebar({
  courseId,
  currentLessonId,
  sections,
  completedIds,
}: LessonSidebarProps) {
  return (
    <div className="py-2">
      {sections.map((section) => (
        <div key={section.id} className="mb-2">
          <div className="px-4 pt-3 pb-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-(--color-text-muted)">
              {section.title}
            </span>
          </div>

          {section.lessons.map((lesson) => {
            const isCurrent = lesson.id === currentLessonId;
            const isCompleted = completedIds.has(lesson.id);

            return (
              <Link
                key={lesson.id}
                href={`/courses/${courseId}/lessons/${lesson.id}`}
                className={`flex items-start gap-2.5 px-4 py-2.5 text-xs leading-snug transition-colors ${
                  isCurrent
                    ? "bg-(--color-brand-light) text-(--color-brand) font-medium"
                    : "text-(--color-text-secondary) hover:bg-(--color-surface-2)"
                }`}
              >
                {isCompleted ? (
                  <CheckCircle2
                    size={14}
                    className="shrink-0 mt-0.5 text-(--color-success)"
                  />
                ) : isCurrent ? (
                  <Circle
                    size={14}
                    strokeWidth={2.5}
                    className="shrink-0 mt-0.5 text-(--color-brand)"
                  />
                ) : (
                  <Circle
                    size={14}
                    className="shrink-0 mt-0.5 text-(--color-border-strong)"
                  />
                )}

                <span
                  className={`shrink-0 mt-0.5 ${
                    lesson.isAiQuiz
                      ? "text-(--color-ai)"
                      : isCurrent
                        ? "text-(--color-brand)"
                        : "text-(--color-text-muted)"
                  }`}
                >
                  {lesson.isAiQuiz ? (
                    <span className="text-[11px]">✦</span>
                  ) : (
                    TYPE_ICONS[lesson.type]
                  )}
                </span>

                <span className="flex-1 truncate">
                  {lesson.title}
                  {lesson.isAiQuiz && (
                    <span className="ml-1 text-[10px] text-(--color-ai) font-medium">
                      (AI)
                    </span>
                  )}
                </span>
              </Link>
            );
          })}
        </div>
      ))}
    </div>
  );
}
