"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "gooey-toast";
import { AlertCircle, X } from "lucide-react";

import {
  LessonList,
  type SectionItem,
  type LessonItem,
} from "@/components/course/LessonList";
import { LessonEditor } from "@/components/course/LessonEditor";

type CourseStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";

interface CourseEditorProps {
  courseId: string;
  initialSections: SectionItem[];
  courseTitle: string;
  courseStatus: CourseStatus;
}

const STATUS_BADGE: Record<CourseStatus, { label: string; className: string }> =
  {
    DRAFT: {
      label: "Draft",
      className: "bg-(--color-surface-3) text-(--color-text-muted)",
    },
    PUBLISHED: {
      label: "Live",
      className: "bg-(--color-success-bg) text-(--color-success)",
    },
    ARCHIVED: {
      label: "Archived",
      className: "bg-amber-50 text-amber-600",
    },
  };

export function CourseEditor({
  courseId,
  initialSections,
  courseTitle,
  courseStatus: initialStatus,
}: CourseEditorProps) {
  const router = useRouter();
  const [sections, setSections] = useState<SectionItem[]>(initialSections);
  const [selectedLessonId, setSelectedLessonId] = useState<string | null>(null);
  const [status, setStatus] = useState<CourseStatus>(initialStatus);
  const [publishErrors, setPublishErrors] = useState<string[]>([]);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);

  const selectedSection = sections.find((s) =>
    s.lessons.some((l) => l.id === selectedLessonId),
  );
  const selectedLesson = selectedSection?.lessons.find(
    (l) => l.id === selectedLessonId,
  );

  async function addSection(title: string) {
    const res = await fetch(`/api/courses/${courseId}/sections`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, order: sections.length }),
    });
    if (res.ok) {
      const section = (await res.json()) as SectionItem;
      setSections((prev) => [...prev, { ...section, lessons: [] }]);
    }
  }

  async function addLesson(sectionId: string, title: string) {
    const section = sections.find((s) => s.id === sectionId);
    const res = await fetch(
      `/api/courses/${courseId}/sections/${sectionId}/lessons`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          type: "VIDEO",
          order: section?.lessons.length ?? 0,
        }),
      },
    );
    if (res.ok) {
      const lesson = (await res.json()) as LessonItem;
      setSections((prev) =>
        prev.map((s) =>
          s.id === sectionId ? { ...s, lessons: [...s.lessons, lesson] } : s,
        ),
      );
      setSelectedLessonId(lesson.id);
    }
  }

  function handleLessonUpdate(lessonId: string, patch: Partial<LessonItem>) {
    setSections((prev) =>
      prev.map((s) => ({
        ...s,
        lessons: s.lessons.map((l) =>
          l.id === lessonId ? { ...l, ...patch } : l,
        ),
      })),
    );
  }

  function handleAiOutline() {
    toast.info({
      title: "Coming in Phase 4",
      description: "AI outline will be available soon.",
    });
  }

  async function handlePublish() {
    setIsPublishing(true);
    setPublishErrors([]);
    try {
      const res = await fetch(`/api/courses/${courseId}/publish`, {
        method: "POST",
      });
      const data = (await res.json()) as {
        errors?: string[];
        status?: CourseStatus;
      };
      if (!res.ok) {
        setPublishErrors(data.errors ?? ["Failed to publish course."]);
        return;
      }
      setStatus("PUBLISHED");
      toast.success({
        title: "Course is live!",
        description: "Students can now enroll.",
      });
      router.refresh();
    } catch {
      toast.error({
        title: "Network error",
        description: "Failed to publish course.",
      });
    } finally {
      setIsPublishing(false);
    }
  }

  async function handleArchive() {
    setIsArchiving(true);
    try {
      const res = await fetch(`/api/courses/${courseId}/archive`, {
        method: "POST",
      });
      if (!res.ok) {
        toast.error({
          title: "Archive failed",
          description: "Could not archive this course.",
        });
        return;
      }
      setStatus("ARCHIVED");
      setPublishErrors([]);
      toast.info({
        title: "Course archived",
        description: "Hidden from new students. Existing enrollments continue.",
      });
      router.refresh();
    } catch {
      toast.error({
        title: "Network error",
        description: "Failed to archive course.",
      });
    } finally {
      setIsArchiving(false);
    }
  }

  const badge = STATUS_BADGE[status];
  const canPublish = status !== "PUBLISHED";
  const canArchive = status !== "ARCHIVED";

  return (
    <div className="flex h-full">
      {/* Left sidebar — course structure */}
      <aside className="w-64 shrink-0 border-r border-border flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <div className="min-w-0">
            <p className="text-xs text-text-muted font-medium uppercase tracking-wide">
              Course
            </p>
            <p className="text-sm font-semibold text-text-primary truncate">
              {courseTitle}
            </p>
          </div>
          <span
            className={`shrink-0 text-[10px] px-2 py-0.5 rounded-full font-medium ${badge.className}`}
          >
            {badge.label}
          </span>
        </div>

        <LessonList
          courseId={courseId}
          sections={sections}
          selectedLessonId={selectedLessonId}
          onSelectLesson={(lessonId) => setSelectedLessonId(lessonId)}
          onAddSection={addSection}
          onAddLesson={addLesson}
          onReorder={setSections}
        />
      </aside>

      {/* Right panel — editor */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Toolbar */}
        <div className="h-12 px-6 border-b border-border flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => router.push(`/courses/${courseId}/settings`)}
              className="text-sm text-text-muted hover:text-text-primary transition-colors"
            >
              Settings
            </button>
            <button
              type="button"
              onClick={() => router.push(`/courses/${courseId}/analytics`)}
              className="text-sm text-text-muted hover:text-text-primary transition-colors"
            >
              Analytics →
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleAiOutline}
              className="flex items-center gap-1.5 bg-ai text-white rounded-md px-3 py-1.5 text-sm font-medium hover:opacity-90 transition-opacity"
            >
              ✦ AI Outline
            </button>

            {canArchive && (
              <button
                type="button"
                onClick={() => void handleArchive()}
                disabled={isArchiving}
                className="text-sm font-medium text-text-muted hover:text-amber-600 transition-colors disabled:opacity-50"
              >
                {isArchiving ? "Archiving…" : "Archive"}
              </button>
            )}

            <button
              type="button"
              onClick={() => void handlePublish()}
              disabled={!canPublish || isPublishing}
              className="bg-brand text-white rounded-md px-3 py-1.5 text-sm font-medium hover:bg-brand-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isPublishing
                ? "Publishing…"
                : status === "PUBLISHED"
                  ? "Published"
                  : "Publish"}
            </button>
          </div>
        </div>

        {/* Publish error panel */}
        {publishErrors.length > 0 && (
          <div className="px-6 py-3 border-b border-red-200 bg-red-50 flex items-start gap-2 shrink-0">
            <AlertCircle size={15} className="shrink-0 mt-0.5 text-red-500" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-red-700 mb-1">
                Fix these issues before publishing:
              </p>
              <ul className="space-y-0.5">
                {publishErrors.map((err, i) => (
                  <li key={i} className="text-sm text-red-600">
                    · {err}
                  </li>
                ))}
              </ul>
            </div>
            <button
              type="button"
              onClick={() => setPublishErrors([])}
              className="shrink-0 text-red-400 hover:text-red-600 transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        )}

        {/* Editor area */}
        <div className="flex-1 overflow-y-auto p-6">
          {selectedLesson && selectedSection ? (
            <LessonEditor
              key={selectedLesson.id}
              lesson={selectedLesson}
              courseId={courseId}
              sectionId={selectedSection.id}
              onUpdate={handleLessonUpdate}
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-center py-16">
              <div className="text-3xl mb-3">📝</div>
              <h3 className="text-base font-semibold text-text-primary mb-1">
                Select a lesson to edit
              </h3>
              <p className="text-sm text-text-muted">
                Choose a lesson from the sidebar or add a new one.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
