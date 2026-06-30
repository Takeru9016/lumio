"use client";

import { useState, useEffect, useRef } from "react";
import {
  Loader2,
  AlertCircle,
  CheckCircle,
  CheckCircle2,
  UploadCloud,
  Video,
  FileText,
  HelpCircle,
  ClipboardList,
} from "lucide-react";
import { toast } from "gooey-toast";

import { TextEditor } from "@/components/course/TextEditor";
import { VideoPlayer } from "@/components/course/VideoPlayer";
import { QuizBuilder } from "@/components/course/QuizBuilder";
import { AssignmentBuilder } from "@/components/course/AssignmentBuilder";
import { InlineInput } from "@/components/course/InlineInput";
import type { LessonItem } from "@/components/course/LessonList";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";

import { useUploadThing } from "@/lib/uploadthing";

import type { LessonType } from "@/generated/prisma/enums";

interface LessonEditorProps {
  lesson: LessonItem;
  courseId: string;
  sectionId: string;
  onUpdate: (lessonId: string, patch: Partial<LessonItem>) => void;
}

type UploadState = "idle" | "uploading" | "processing" | "ready";
type SaveStatus = "idle" | "saving" | "saved" | "error";

const LESSON_TYPES: {
  value: LessonType;
  label: string;
  icon: React.ReactNode;
}[] = [
  { value: "VIDEO", label: "Video", icon: <Video size={13} /> },
  { value: "TEXT", label: "Text", icon: <FileText size={13} /> },
  { value: "QUIZ", label: "Quiz", icon: <HelpCircle size={13} /> },
  {
    value: "ASSIGNMENT",
    label: "Assignment",
    icon: <ClipboardList size={13} />,
  },
];

const TYPE_LABELS: Record<LessonType, string> = {
  VIDEO: "Video",
  TEXT: "Text",
  QUIZ: "Quiz",
  ASSIGNMENT: "Assignment",
};

export function LessonEditor({
  lesson,
  courseId,
  sectionId,
  onUpdate,
}: LessonEditorProps) {
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [localIsPublished, setLocalIsPublished] = useState(lesson.isPublished);
  const [localType, setLocalType] = useState<LessonType>(lesson.type);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadState, setUploadState] = useState<UploadState>(
    lesson.videoStatus === "READY"
      ? "ready"
      : lesson.videoStatus === "PROCESSING"
        ? "processing"
        : "idle",
  );
  const [previewPlaybackId, setPreviewPlaybackId] = useState<string | null>(
    lesson.muxPlaybackId ?? null,
  );
  const [pendingType, setPendingType] = useState<LessonType | null>(null);
  const [isRenamingTitle, setIsRenamingTitle] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onUpdateRef = useRef(onUpdate);
  useEffect(() => {
    onUpdateRef.current = onUpdate;
  }, [onUpdate]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  // On mount, fetch fresh lesson state from DB in case props are stale
  // (component remounts on lesson switch via key={lesson.id} in CourseEditor)
  useEffect(() => {
    if (lesson.type !== "VIDEO") return;
    async function refresh() {
      try {
        const res = await fetch(
          `/api/courses/${courseId}/sections/${sectionId}/lessons/${lesson.id}`,
        );
        if (!res.ok) return;
        const data = (await res.json()) as {
          videoStatus: string;
          muxPlaybackId: string | null;
        };
        if (data.videoStatus === "READY" && data.muxPlaybackId) {
          setUploadState("ready");
          setPreviewPlaybackId(data.muxPlaybackId);
        } else if (data.videoStatus === "PROCESSING") {
          setUploadState((s) => (s === "idle" ? "processing" : s));
        }
      } catch {
        // ignore — use prop-initialised state
      }
    }
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // empty — runs once per mount; key={lesson.id} handles lesson changes

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
            ...(current.muxPlaybackId
              ? { muxPlaybackId: current.muxPlaybackId }
              : {}),
          } as Partial<LessonItem>);
        } else if (current.videoStatus === "ERROR") {
          clearInterval(interval);
          setUploadState("idle");
          onUpdateRef.current(lesson.id, { videoStatus: "ERROR" });
          toast.error({
            title: "Video processing failed",
            description: "Please re-upload the video.",
          });
        }
      } catch {
        // network blip — keep polling
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [uploadState, courseId, sectionId, lesson.id]);

  // Content detection for each type
  const hasVideoContent =
    previewPlaybackId !== null ||
    (lesson.muxPlaybackId !== null && lesson.muxPlaybackId !== undefined);
  const hasTextContent =
    !!lesson.textContent && lesson.textContent.trim() !== "";
  const hasQuizContent = lesson.hasQuiz === true;
  const hasAssignmentContent = lesson.hasAssignment === true;

  function contentExistsForType(type: LessonType): boolean {
    switch (type) {
      case "VIDEO":
        return hasVideoContent;
      case "TEXT":
        return hasTextContent;
      case "QUIZ":
        return hasQuizContent;
      case "ASSIGNMENT":
        return hasAssignmentContent;
    }
  }

  function typeHasIndicator(type: LessonType): boolean {
    switch (type) {
      case "VIDEO":
        return hasVideoContent;
      case "TEXT":
        return hasTextContent;
      case "QUIZ":
        return hasQuizContent;
      case "ASSIGNMENT":
        return hasAssignmentContent;
    }
  }

  function requestTypeChange(type: LessonType) {
    if (type === localType) return;
    if (contentExistsForType(localType)) {
      setPendingType(type);
    } else {
      void commitTypeChange(type);
    }
  }

  async function commitTypeChange(type: LessonType) {
    const prev = localType;
    setLocalType(type);
    onUpdate(lesson.id, { type });
    setPendingType(null);

    try {
      const res = await fetch(
        `/api/courses/${courseId}/sections/${sectionId}/lessons/${lesson.id}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type }),
        },
      );
      if (!res.ok) throw new Error();
    } catch {
      setLocalType(prev);
      onUpdate(lesson.id, { type: prev });
      toast.error({ title: "Failed to update lesson type" });
    }
  }

  async function saveText(html: string) {
    setSaveStatus("saving");
    try {
      const res = await fetch(
        `/api/courses/${courseId}/sections/${sectionId}/lessons/${lesson.id}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ textContent: html }),
        },
      );
      if (!res.ok) throw new Error("Save failed");
      onUpdateRef.current(lesson.id, { textContent: html });
      setSaveStatus("saved");
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSaveStatus("idle"), 2000);
    } catch {
      setSaveStatus("error");
      toast.error({ title: "Failed to save lesson content" });
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSaveStatus("idle"), 3000);
    }
  }

  async function saveTitle(title: string) {
    try {
      const res = await fetch(
        `/api/courses/${courseId}/sections/${sectionId}/lessons/${lesson.id}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title }),
        },
      );
      if (!res.ok) throw new Error();
      onUpdateRef.current(lesson.id, { title });
    } catch {
      toast.error({ title: "Failed to rename lesson" });
    }
  }

  async function togglePublish() {
    const next = !localIsPublished;
    setLocalIsPublished(next);
    onUpdateRef.current(lesson.id, { isPublished: next });
    try {
      const res = await fetch(
        `/api/courses/${courseId}/sections/${sectionId}/lessons/${lesson.id}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isPublished: next }),
        },
      );
      if (!res.ok) throw new Error();
    } catch {
      setLocalIsPublished(!next);
      onUpdateRef.current(lesson.id, { isPublished: !next });
      toast.error({ title: "Failed to update lesson status" });
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
      <div className="flex items-center justify-between gap-3">
        {isRenamingTitle ? (
          <div className="flex-1 min-w-0">
            <InlineInput
              placeholder="Lesson title"
              defaultValue={lesson.title}
              confirmLabel="Save"
              onConfirm={(title) => {
                setIsRenamingTitle(false);
                void saveTitle(title);
              }}
              onCancel={() => setIsRenamingTitle(false)}
            />
          </div>
        ) : (
          <h2
            className="text-base font-semibold text-text-primary truncate cursor-pointer hover:text-brand transition-colors"
            onClick={() => setIsRenamingTitle(true)}
            title="Click to rename"
          >
            {lesson.title}
          </h2>
        )}
        <div className="flex items-center gap-3 shrink-0">
          {saveStatus === "saving" && (
            <span className="flex items-center gap-1 text-xs text-text-muted">
              <Loader2 size={12} className="animate-spin" /> Saving…
            </span>
          )}
          {saveStatus === "saved" && (
            <span className="flex items-center gap-1 text-xs text-success">
              <CheckCircle2 size={12} /> Saved
            </span>
          )}
          {saveStatus === "error" && (
            <span className="text-xs text-danger">Save failed</span>
          )}
          <button
            type="button"
            onClick={() => void togglePublish()}
            className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
              localIsPublished
                ? "bg-success-bg text-success hover:opacity-80"
                : "bg-surface-3 text-text-muted hover:bg-brand-light hover:text-brand"
            }`}
          >
            {localIsPublished ? "Live" : "Draft"}
          </button>
        </div>
      </div>

      {/* Type selector */}
      <div className="flex items-center gap-1 p-1 bg-surface-3 rounded-lg">
        {LESSON_TYPES.map(({ value, label, icon }) => (
          <button
            key={value}
            type="button"
            onClick={() => requestTypeChange(value)}
            className={`flex flex-1 items-center justify-center gap-1.5 px-2 py-1.5 text-xs font-medium rounded-md transition-colors ${
              localType === value
                ? "bg-brand text-white"
                : "bg-white text-text-muted border border-border hover:text-text-primary"
            }`}
          >
            {icon}
            {label}
            {typeHasIndicator(value) && (
              <span
                className={`text-[9px] font-bold leading-none ${
                  localType === value ? "text-white/80" : "text-success"
                }`}
              >
                ✓
              </span>
            )}
          </button>
        ))}
      </div>

      {/* VIDEO */}
      {localType === "VIDEO" && (
        <div className="space-y-4">
          {(uploadState === "uploading" || isUploading) && (
            <div className="space-y-2">
              <div className="w-full h-1.5 bg-surface-3 rounded-full overflow-hidden">
                <div
                  className="h-full bg-brand rounded-full transition-all duration-300"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
              <p className="text-xs text-text-muted">
                Uploading… {uploadProgress}%
              </p>
            </div>
          )}

          {uploadState === "processing" && (
            <div className="space-y-2">
              <div className="w-full aspect-video rounded-lg bg-surface-3 animate-pulse flex items-center justify-center">
                <div className="text-center">
                  <Loader2
                    size={20}
                    className="animate-spin text-text-muted mx-auto mb-2"
                  />
                  <p className="text-sm text-text-muted">
                    ⚙ Processing video… this may take a minute
                  </p>
                </div>
              </div>
            </div>
          )}

          {uploadState === "ready" && previewPlaybackId && (
            <div className="space-y-2">
              <VideoPlayer playbackId={previewPlaybackId} videoStatus="READY" />
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs text-success">
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
                  className="text-xs text-text-muted hover:text-text-primary transition-colors"
                >
                  Replace video
                </button>
              </div>
            </div>
          )}

          {uploadState === "idle" && (
            <div className="space-y-3">
              {lesson.videoStatus === "ERROR" && (
                <div className="flex items-center gap-3 rounded-lg border border-danger bg-danger-bg px-4 py-3">
                  <AlertCircle size={16} className="text-danger shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-danger">
                      Video processing failed
                    </p>
                    <p className="text-xs text-text-muted">
                      Please re-upload the video below
                    </p>
                  </div>
                </div>
              )}

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="w-full flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-border bg-surface-2 py-10 hover:border-brand hover:bg-brand-light transition-colors group"
              >
                <UploadCloud
                  size={28}
                  className="text-text-muted group-hover:text-brand transition-colors"
                />
                <div className="text-center">
                  <p className="text-sm font-medium text-text-primary">
                    Click to upload video
                  </p>
                  <p className="text-xs text-text-muted mt-0.5">
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
      {localType === "TEXT" && (
        <TextEditor
          content={lesson.textContent ?? ""}
          onChange={(html) => {
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
            saveTimerRef.current = setTimeout(() => void saveText(html), 1000);
          }}
        />
      )}

      {/* QUIZ */}
      {localType === "QUIZ" && (
        <QuizBuilder courseId={courseId} lessonId={lesson.id} />
      )}

      {/* ASSIGNMENT */}
      {localType === "ASSIGNMENT" && (
        <AssignmentBuilder courseId={courseId} lessonId={lesson.id} />
      )}

      {/* Type switch confirmation */}
      <Dialog
        open={pendingType !== null}
        onOpenChange={(open) => {
          if (!open) setPendingType(null);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogTitle>Switch to {pendingType ? TYPE_LABELS[pendingType] : ""}?</DialogTitle>
          <p className="text-sm text-text-muted -mt-2">
            This lesson currently has{" "}
            <strong>{TYPE_LABELS[localType]}</strong> content. Switching to{" "}
            <strong>{pendingType ? TYPE_LABELS[pendingType] : ""}</strong> will
            hide it from students, but it stays saved if you switch back.
          </p>
          <div className="flex items-center justify-end gap-2 mt-4">
            <button
              type="button"
              onClick={() => setPendingType(null)}
              className="px-3 py-1.5 text-sm text-text-muted hover:text-text-primary hover:bg-surface-3 rounded-md transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => pendingType && void commitTypeChange(pendingType)}
              className="px-3 py-1.5 text-sm font-medium bg-brand text-white rounded-md hover:bg-brand-dark transition-colors"
            >
              Switch anyway
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
