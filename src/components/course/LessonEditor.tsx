"use client";

import { useState } from "react";
import { Loader2, AlertCircle, CheckCircle } from "lucide-react";
import { TextEditor } from "@/components/course/TextEditor";
import { UploadDropzone } from "@/lib/uploadthing";
import { VideoPlayer } from "@/components/course/VideoPlayer";
import type { LessonItem } from "@/components/course/LessonList";

interface LessonEditorProps {
  lesson: LessonItem & {
    textContent?: string | null;
    muxPlaybackId?: string | null;
  };
  onUpdate: (lessonId: string, patch: Partial<LessonItem & { textContent?: string }>) => void;
}

export function LessonEditor({ lesson, onUpdate }: LessonEditorProps) {
  const [isSaving, setIsSaving] = useState(false);

  async function saveText(html: string) {
    setIsSaving(true);
    try {
      await fetch(`/api/lessons/${lesson.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ textContent: html }),
      });
      onUpdate(lesson.id, { textContent: html } as Partial<LessonItem & { textContent?: string }>);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-(--color-text-primary) truncate">
          {lesson.title}
        </h2>
        {isSaving && (
          <span className="flex items-center gap-1 text-xs text-(--color-text-muted)">
            <Loader2 size={12} className="animate-spin" /> Saving…
          </span>
        )}
      </div>

      {/* VIDEO */}
      {lesson.type === "VIDEO" && (
        <div className="space-y-4">
          {lesson.videoStatus === "PROCESSING" && (
            <div className="flex items-center gap-3 rounded-lg border border-(--color-border) bg-(--color-surface-2) px-4 py-3">
              <Loader2 size={16} className="animate-spin text-(--color-text-muted) shrink-0" />
              <div>
                <p className="text-sm font-medium text-(--color-text-primary)">Processing video…</p>
                <p className="text-xs text-(--color-text-muted)">This usually takes 1–3 minutes</p>
              </div>
            </div>
          )}

          {lesson.videoStatus === "ERROR" && (
            <div className="flex items-center gap-3 rounded-lg border border-(--color-danger) bg-(--color-danger-bg) px-4 py-3">
              <AlertCircle size={16} className="text-(--color-danger) shrink-0" />
              <div>
                <p className="text-sm font-medium text-(--color-danger)">Video processing failed</p>
                <p className="text-xs text-(--color-text-muted)">Please re-upload the video</p>
              </div>
            </div>
          )}

          {lesson.videoStatus === "READY" && lesson.muxPlaybackId && (
            <div className="space-y-2">
              <VideoPlayer playbackId={lesson.muxPlaybackId} videoStatus="READY" />
              <div className="flex items-center gap-1.5 text-xs text-(--color-success)">
                <CheckCircle size={13} />
                Video ready
              </div>
            </div>
          )}

          {(lesson.videoStatus === "PENDING" || lesson.videoStatus === "ERROR") && (
            <UploadDropzone
              endpoint="videoUploader"
              input={{ lessonId: lesson.id }}
              onClientUploadComplete={(res) => {
                if (res[0]?.serverData) {
                  onUpdate(lesson.id, { videoStatus: "PROCESSING" });
                }
              }}
              onUploadError={(e) => console.error(e)}
            />
          )}
        </div>
      )}

      {/* TEXT */}
      {lesson.type === "TEXT" && (
        <TextEditor
          content={lesson.textContent ?? ""}
          onChange={(html) => {
            const debounced = setTimeout(() => saveText(html), 1000);
            return () => clearTimeout(debounced);
          }}
        />
      )}

      {/* QUIZ */}
      {lesson.type === "QUIZ" && (
        <div className="rounded-lg border border-(--color-border) bg-(--color-surface-2) px-6 py-10 text-center">
          <p className="text-sm font-medium text-(--color-text-primary) mb-1">
            Quiz builder coming in Phase 3
          </p>
          <p className="text-xs text-(--color-text-muted)">
            Add questions and auto-grade student responses.
          </p>
        </div>
      )}

      {/* ASSIGNMENT */}
      {lesson.type === "ASSIGNMENT" && (
        <div className="rounded-lg border border-(--color-border) bg-(--color-surface-2) px-6 py-10 text-center">
          <p className="text-sm font-medium text-(--color-text-primary) mb-1">
            Assignment builder coming in Phase 3
          </p>
          <p className="text-xs text-(--color-text-muted)">
            Set instructions, deadlines, and rubrics.
          </p>
        </div>
      )}
    </div>
  );
}
