"use client";

import { useState, useEffect, useRef } from "react";
import { Loader2, AlertCircle, CheckCircle, UploadCloud } from "lucide-react";
import { TextEditor } from "@/components/course/TextEditor";
import { VideoPlayer } from "@/components/course/VideoPlayer";
import { useUploadThing } from "@/lib/uploadthing";
import { toast } from "gooey-toast";
import type { LessonItem } from "@/components/course/LessonList";

interface LessonEditorProps {
  lesson: LessonItem & {
    textContent?: string | null;
    muxPlaybackId?: string | null;
  };
  courseId: string;
  sectionId: string;
  onUpdate: (lessonId: string, patch: Partial<LessonItem & { textContent?: string }>) => void;
}

type UploadState = "idle" | "uploading" | "processing" | "ready";

export function LessonEditor({ lesson, courseId, sectionId, onUpdate }: LessonEditorProps) {
  const [isSaving, setIsSaving] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadState, setUploadState] = useState<UploadState>(() => {
    if (lesson.videoStatus === "READY" && lesson.muxPlaybackId) return "ready";
    if (lesson.videoStatus === "PROCESSING") return "processing";
    return "idle";
  });
  const [previewPlaybackId, setPreviewPlaybackId] = useState<string | null>(
    lesson.muxPlaybackId ?? null,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const onUpdateRef = useRef(onUpdate);
  useEffect(() => { onUpdateRef.current = onUpdate; }, [onUpdate]);

  const { startUpload, isUploading } = useUploadThing("videoUploader", {
    onUploadProgress: (p) => setUploadProgress(p),
    onClientUploadComplete: () => {
      setUploadState("processing");
      setUploadProgress(0);
      onUpdateRef.current(lesson.id, { videoStatus: "PROCESSING" });
    },
    onUploadError: (e) => {
      toast.error({ title: "Video upload failed", description: e.message });
      setUploadState("idle");
      setUploadProgress(0);
    },
  });

  useEffect(() => {
    if (uploadState !== "processing") return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(
          `/api/courses/${courseId}/sections/${sectionId}/lessons`,
        );
        if (!res.ok) return;
        const lessons = (await res.json()) as Array<{
          id: string;
          videoStatus: string;
          muxPlaybackId: string | null;
        }>;
        const current = lessons.find((l) => l.id === lesson.id);
        if (!current) return;

        if (current.videoStatus === "READY") {
          clearInterval(interval);
          setUploadState("ready");
          setPreviewPlaybackId(current.muxPlaybackId);
          onUpdateRef.current(lesson.id, {
            videoStatus: "READY",
            ...(current.muxPlaybackId ? { muxPlaybackId: current.muxPlaybackId } : {}),
          } as Partial<LessonItem>);
        } else if (current.videoStatus === "ERROR") {
          clearInterval(interval);
          setUploadState("idle");
          onUpdateRef.current(lesson.id, { videoStatus: "ERROR" });
          toast.error({ title: "Video processing failed", description: "Please re-upload the video." });
        }
      } catch {
        // network blip — keep polling
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [uploadState, courseId, sectionId, lesson.id]);

  async function saveText(html: string) {
    setIsSaving(true);
    try {
      await fetch(
        `/api/courses/${courseId}/sections/${sectionId}/lessons/${lesson.id}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ textContent: html }),
        },
      );
      onUpdateRef.current(lesson.id, { textContent: html } as Partial<LessonItem & { textContent?: string }>);
    } finally {
      setIsSaving(false);
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    setUploadState("uploading");
    void startUpload(files, { lessonId: lesson.id });
    e.target.value = "";
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
          {/* Uploading state — progress bar */}
          {(uploadState === "uploading" || isUploading) && (
            <div className="space-y-2">
              <div className="w-full h-1.5 bg-(--color-surface-3) rounded-full overflow-hidden">
                <div
                  className="h-full bg-(--color-brand) rounded-full transition-all duration-300"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
              <p className="text-xs text-(--color-text-muted)">
                Uploading… {uploadProgress}%
              </p>
            </div>
          )}

          {/* Processing state — pulsing placeholder */}
          {uploadState === "processing" && (
            <div className="space-y-2">
              <div className="w-full aspect-video rounded-lg bg-(--color-surface-3) animate-pulse flex items-center justify-center">
                <div className="text-center">
                  <Loader2 size={20} className="animate-spin text-(--color-text-muted) mx-auto mb-2" />
                  <p className="text-sm text-(--color-text-muted)">
                    ⚙ Processing video… this may take a minute
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Ready state — player + replace button */}
          {uploadState === "ready" && previewPlaybackId && (
            <div className="space-y-2">
              <VideoPlayer playbackId={previewPlaybackId} videoStatus="READY" />
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs text-(--color-success)">
                  <CheckCircle size={13} />
                  Video ready
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setUploadState("idle");
                    setPreviewPlaybackId(null);
                    setUploadProgress(0);
                  }}
                  className="text-xs text-(--color-text-muted) hover:text-(--color-text-primary) transition-colors"
                >
                  Replace video
                </button>
              </div>
            </div>
          )}

          {/* Idle state — upload dropzone */}
          {uploadState === "idle" && (
            <div className="space-y-3">
              {lesson.videoStatus === "ERROR" && (
                <div className="flex items-center gap-3 rounded-lg border border-(--color-danger) bg-(--color-danger-bg) px-4 py-3">
                  <AlertCircle size={16} className="text-(--color-danger) shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-(--color-danger)">Video processing failed</p>
                    <p className="text-xs text-(--color-text-muted)">Please re-upload the video below</p>
                  </div>
                </div>
              )}

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="w-full flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-(--color-border) bg-(--color-surface-2) py-10 hover:border-(--color-brand) hover:bg-(--color-brand-light) transition-colors group"
              >
                <UploadCloud
                  size={28}
                  className="text-(--color-text-muted) group-hover:text-(--color-brand) transition-colors"
                />
                <div className="text-center">
                  <p className="text-sm font-medium text-(--color-text-primary)">
                    Click to upload video
                  </p>
                  <p className="text-xs text-(--color-text-muted) mt-0.5">
                    MP4, MOV, WebM — up to 2GB
                  </p>
                </div>
              </button>

              <input
                ref={fileInputRef}
                type="file"
                accept="video/*"
                className="hidden"
                onChange={handleFileChange}
              />
            </div>
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
