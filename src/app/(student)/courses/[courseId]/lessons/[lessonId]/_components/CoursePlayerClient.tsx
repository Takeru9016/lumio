"use client";

import { useState, useRef } from "react";
import Link from "next/link";
import { ArrowLeft, CheckCircle2 } from "lucide-react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { toast } from "gooey-toast";
import { VideoPlayer } from "@/components/course/VideoPlayer";
import { AiBadge } from "@/components/shared/AiBadge";
import { LessonSidebar, type SidebarSection } from "./LessonSidebar";
import { NotesTab } from "./NotesTab";
import type { LessonType, VideoStatus } from "@/generated/prisma/enums";

interface LessonData {
  id: string;
  title: string;
  type: LessonType;
  muxPlaybackId: string | null;
  videoStatus: VideoStatus;
  textContent: string | null;
}

interface CoursePlayerClientProps {
  courseId: string;
  courseTitle: string;
  lesson: LessonData;
  lessonIndex: number;
  totalLessons: number;
  sections: SidebarSection[];
  initialCompletedIds: string[];
}

type Tab = "notes" | "discussion" | "ai-tutor" | "resources";

const TABS: { id: Tab; label: string }[] = [
  { id: "notes", label: "Notes" },
  { id: "discussion", label: "Discussion" },
  { id: "ai-tutor", label: "AI Tutor" },
  { id: "resources", label: "Resources" },
];

function ReadonlyTextContent({ content }: { content: string }) {
  const editor = useEditor({
    extensions: [StarterKit],
    content,
    editable: false,
    immediatelyRender: false,
  });

  if (!editor) {
    return (
      <div className="min-h-[200px] rounded-lg border border-(--color-border) bg-(--color-surface-2) animate-pulse" />
    );
  }

  return (
    <EditorContent
      editor={editor}
      className="prose prose-sm max-w-none text-(--color-text-primary) [&_.tiptap]:outline-none"
    />
  );
}

export function CoursePlayerClient({
  courseId,
  courseTitle,
  lesson,
  lessonIndex,
  totalLessons,
  sections,
  initialCompletedIds,
}: CoursePlayerClientProps) {
  const [completedIds, setCompletedIds] = useState<Set<string>>(
    () => new Set(initialCompletedIds),
  );
  const [activeTab, setActiveTab] = useState<Tab>("notes");
  const hasPostedRef = useRef(false);

  const completedCount = completedIds.size;
  const progress =
    totalLessons > 0 ? Math.round((completedCount / totalLessons) * 100) : 0;

  async function markComplete() {
    if (hasPostedRef.current) return;
    hasPostedRef.current = true;

    setCompletedIds((prev) => new Set([...prev, lesson.id]));

    try {
      const res = await fetch(
        `/api/courses/${courseId}/lessons/${lesson.id}/complete`,
        { method: "POST" },
      );
      const data = (await res.json()) as {
        xpEarned: number;
        isFirstCompletion: boolean;
        totalCompleted: number;
      };

      if (data.isFirstCompletion && data.xpEarned > 0) {
        toast.success({
          title: `+${data.xpEarned} XP earned!`,
          description: "Lesson complete. Keep going!",
        });
      }
    } catch {
      hasPostedRef.current = false;
      setCompletedIds((prev) => {
        const next = new Set(prev);
        next.delete(lesson.id);
        return next;
      });
    }
  }

  const isCurrentComplete = completedIds.has(lesson.id);

  return (
    <div className="min-h-full bg-(--color-surface-2) flex flex-col">
      {/* Inner top bar */}
      <div className="sticky top-0 z-10 bg-(--color-surface-1) border-b border-(--color-border) px-4 flex items-center gap-3 h-[52px] shrink-0">
        <Link
          href={`/courses/${courseId}`}
          className="flex items-center gap-1.5 text-sm text-(--color-text-muted) hover:text-(--color-text-primary) transition-colors shrink-0"
        >
          <ArrowLeft size={15} />
          <span className="hidden sm:inline">Back</span>
        </Link>

        <div className="w-px h-4 bg-(--color-border) shrink-0" />

        <span className="text-sm font-semibold text-(--color-text-primary) truncate flex-1 min-w-0">
          {courseTitle}
        </span>

        <span className="text-xs text-(--color-text-muted) shrink-0">
          Lesson {lessonIndex} of {totalLessons}
        </span>

        <div className="w-24 shrink-0">
          <div className="h-1.5 rounded-full bg-(--color-surface-3)">
            <div
              className="h-full rounded-full bg-(--color-brand) transition-all duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-[10px] text-(--color-text-disabled) text-right mt-0.5">
            {progress}%
          </p>
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-1 min-h-0">
        {/* Main content */}
        <div className="flex-1 min-w-0 overflow-y-auto">
          <div className="p-4 md:p-6 space-y-4 max-w-4xl">
            {/* Lesson title */}
            <h1 className="text-xl font-bold text-(--color-text-primary)">
              {lesson.title}
            </h1>

            {/* Video or text content */}
            {lesson.type === "VIDEO" ? (
              <VideoPlayer
                playbackId={lesson.muxPlaybackId ?? ""}
                videoStatus={lesson.videoStatus}
                onComplete={markComplete}
              />
            ) : (
              <div className="bg-(--color-surface-1) border border-(--color-border) rounded-lg p-5">
                {lesson.textContent ? (
                  <ReadonlyTextContent content={lesson.textContent} />
                ) : (
                  <p className="text-sm text-(--color-text-muted)">
                    No content yet.
                  </p>
                )}
              </div>
            )}

            {/* Mark complete for non-video lessons */}
            {lesson.type !== "VIDEO" && (
              <div className="flex justify-end">
                {isCurrentComplete ? (
                  <div className="flex items-center gap-2 text-sm font-medium text-(--color-success)">
                    <CheckCircle2 size={16} />
                    Completed
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => void markComplete()}
                    className="flex items-center gap-2 bg-(--color-brand) text-white rounded-md px-4 py-2 text-sm font-medium hover:bg-(--color-brand-dark) transition-colors"
                  >
                    <CheckCircle2 size={15} />
                    Mark as complete
                  </button>
                )}
              </div>
            )}

            {/* Tabs */}
            <div className="bg-(--color-surface-1) border border-(--color-border) rounded-lg overflow-hidden">
              <div className="flex border-b border-(--color-border)">
                {TABS.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    className={`px-4 py-3 text-sm font-medium transition-colors relative ${
                      activeTab === tab.id
                        ? "text-(--color-brand)"
                        : "text-(--color-text-muted) hover:text-(--color-text-primary)"
                    }`}
                  >
                    {tab.id === "ai-tutor" ? (
                      <span className="flex items-center gap-1">
                        ✦ AI Tutor
                      </span>
                    ) : (
                      tab.label
                    )}
                    {activeTab === tab.id && (
                      <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-(--color-brand)" />
                    )}
                  </button>
                ))}
              </div>

              <div className="p-4">
                {activeTab === "notes" && <NotesTab lessonId={lesson.id} />}

                {activeTab === "discussion" && (
                  <div className="py-8 text-center">
                    <p className="text-sm font-medium text-(--color-text-primary) mb-1">
                      Discussion coming soon
                    </p>
                    <p className="text-xs text-(--color-text-muted)">
                      Ask questions and connect with other learners.
                    </p>
                  </div>
                )}

                {activeTab === "ai-tutor" && (
                  <div className="bg-(--color-ai-bg) border border-(--color-ai-border) rounded-lg p-5 flex items-start gap-3">
                    <span className="text-xl text-(--color-ai) shrink-0">✦</span>
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <p className="text-sm font-semibold text-(--color-ai)">
                          AI Tutor
                        </p>
                        <AiBadge label="Phase 4" />
                      </div>
                      <p className="text-sm text-(--color-text-muted)">
                        Ask questions about this lesson, get explanations, and
                        explore concepts deeper. Coming in Phase 4.
                      </p>
                    </div>
                  </div>
                )}

                {activeTab === "resources" && (
                  <div className="py-8 text-center">
                    <p className="text-sm font-medium text-(--color-text-primary) mb-1">
                      No resources for this lesson
                    </p>
                    <p className="text-xs text-(--color-text-muted)">
                      The instructor hasn&apos;t added any attachments yet.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Right sidebar — lesson list */}
        <div className="hidden lg:block w-60 shrink-0 border-l border-(--color-border) bg-(--color-surface-1) sticky top-[52px] h-[calc(100vh-104px)] overflow-y-auto">
          <div className="px-4 py-3 border-b border-(--color-border)">
            <p className="text-xs font-semibold text-(--color-text-primary)">
              Course content
            </p>
          </div>
          <LessonSidebar
            courseId={courseId}
            currentLessonId={lesson.id}
            sections={sections}
            completedIds={completedIds}
          />
        </div>
      </div>
    </div>
  );
}
