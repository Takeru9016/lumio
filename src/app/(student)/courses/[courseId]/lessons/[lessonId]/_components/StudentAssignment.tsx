"use client";

import { useState } from "react";
import {
  Clock,
  CheckCircle2,
  AlertCircle,
  Star,
  UploadCloud,
  Loader2,
  FileCheck,
  X,
} from "lucide-react";
import { format } from "date-fns";
import { toast } from "gooey-toast";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";

import { useUploadThing } from "@/lib/uploadthing";

export interface AssignmentSubmissionData {
  id: string;
  status: "SUBMITTED" | "GRADED" | "LATE";
  textContent: string | null;
  fileUrl: string | null;
  score: number | null;
  feedback: string | null;
  submittedAt: string;
  gradedAt: string | null;
}

export interface StudentAssignmentData {
  id: string;
  title: string;
  description: string;
  dueDate: string | null;
  maxScore: number;
  submission: AssignmentSubmissionData | null;
}

interface StudentAssignmentProps {
  assignment: StudentAssignmentData;
  onComplete?: () => void;
}

const STATUS_CONFIG = {
  SUBMITTED: {
    label: "Submitted",
    className: "bg-brand-light text-brand",
  },
  GRADED: { label: "Graded", className: "bg-success-bg text-success" },
  LATE: { label: "Late", className: "bg-warning-bg text-warning" },
} as const;

function ReadonlyHtml({ html }: { html: string }) {
  const editor = useEditor({
    extensions: [StarterKit],
    content: html,
    editable: false,
    immediatelyRender: false,
  });

  if (!editor) {
    return (
      <div className="min-h-[80px] rounded-lg bg-surface-2 animate-pulse" />
    );
  }

  return (
    <EditorContent
      editor={editor}
      className="prose prose-sm max-w-none text-text-primary [&_.tiptap]:outline-none"
    />
  );
}

export function StudentAssignment({
  assignment,
  onComplete,
}: StudentAssignmentProps) {
  const [submission, setSubmission] = useState<AssignmentSubmissionData | null>(
    assignment.submission,
  );
  const [uploadedFileUrl, setUploadedFileUrl] = useState<string | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { startUpload, isUploading } = useUploadThing("assignmentUploader", {
    onClientUploadComplete: (res) => {
      if (res?.[0]) {
        setUploadedFileUrl(res[0].ufsUrl);
        setUploadedFileName(res[0].name);
        toast.success({ title: "File uploaded successfully." });
      }
    },
    onUploadError: (err) => {
      toast.error({ title: `File upload failed: ${err.message}` });
    },
  });

  const isLocked = submission?.status === "GRADED";
  const isPastDue = assignment.dueDate
    ? new Date() > new Date(assignment.dueDate)
    : false;

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({
        placeholder: "Write your submission here…",
      }),
    ],
    content: submission?.textContent ?? "",
    editable: !isLocked,
    immediatelyRender: false,
  });

  async function handleSubmit() {
    const html = editor?.getHTML() ?? "";
    const hasText = html.trim() !== "" && html !== "<p></p>";
    const hasFile = !!uploadedFileUrl;

    if (!hasText && !hasFile) {
      toast.error({ title: "Add text or upload a file before submitting." });
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await fetch(`/api/assignments/${assignment.id}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          textContent: hasText ? html : null,
          fileUrl: hasFile ? uploadedFileUrl : null,
        }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        toast.error({ title: data.error ?? "Submission failed." });
        return;
      }

      const data = (await res.json()) as {
        submission: AssignmentSubmissionData;
        xpAwarded: number;
      };
      setSubmission(data.submission);
      setUploadedFileUrl(null);
      setUploadedFileName(null);

      if (data.xpAwarded > 0) {
        toast.success({
          title: `+${data.xpAwarded} XP earned!`,
          description: "Assignment submitted.",
        });
      } else {
        toast.success({ title: "Assignment submitted." });
      }

      onComplete?.();
    } catch {
      toast.error({ title: "Submission failed. Please try again." });
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    void startUpload(files);
    e.target.value = "";
  }

  return (
    <div className="space-y-4">
      {/* Assignment brief */}
      <div className="bg-surface-1 border border-border rounded-lg p-5 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold text-text-primary">
            {assignment.title}
          </h2>
          {submission && (
            <span
              className={`shrink-0 text-xs font-semibold px-2 py-0.5 rounded-full ${STATUS_CONFIG[submission.status].className}`}
            >
              {STATUS_CONFIG[submission.status].label}
            </span>
          )}
        </div>

        <div className="flex items-center gap-4 text-xs text-text-muted">
          {assignment.dueDate && (
            <span className="flex items-center gap-1">
              <Clock size={12} />
              Due {format(new Date(assignment.dueDate), "MMM d, yyyy")}
              {isPastDue && !submission && (
                <span className="ml-1 font-medium text-warning">(past due)</span>
              )}
            </span>
          )}
          <span className="flex items-center gap-1">
            <Star size={12} />
            {assignment.maxScore} points
          </span>
        </div>

        <div className="pt-2 border-t border-border">
          <ReadonlyHtml html={assignment.description} />
        </div>
      </div>

      {/* Grade / feedback */}
      {submission?.status === "GRADED" && (
        <div className="bg-success-bg border border-success rounded-lg p-4 space-y-2">
          <div className="flex items-center gap-2">
            <CheckCircle2 size={16} className="text-success" />
            <p className="text-sm font-semibold text-success">
              Score: {submission.score}/{assignment.maxScore}
            </p>
          </div>
          {submission.feedback && (
            <p className="text-sm text-text-primary pl-6">
              {submission.feedback}
            </p>
          )}
          {submission.gradedAt && (
            <p className="text-xs text-text-muted pl-6">
              Graded on{" "}
              {format(new Date(submission.gradedAt), "MMM d, yyyy")}
            </p>
          )}
        </div>
      )}

      {/* Submission form — hidden when graded */}
      {!isLocked && (
        <div className="bg-surface-1 border border-border rounded-lg p-5 space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-text-primary">
              Your submission
            </p>
            {submission && (
              <span className="text-xs text-text-muted">
                Last submitted{" "}
                {format(
                  new Date(submission.submittedAt),
                  "MMM d 'at' h:mm a",
                )}
              </span>
            )}
          </div>

          {isPastDue && !submission && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-warning-bg border border-warning text-sm text-warning">
              <AlertCircle size={14} className="shrink-0" />
              Past due — your submission will be marked late.
            </div>
          )}

          {/* Tiptap editor */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              Written response{" "}
              <span className="text-text-disabled font-normal">(optional)</span>
            </label>
            <div className="rounded-lg border border-border overflow-hidden">
              <EditorContent
                editor={editor}
                className="prose prose-sm max-w-none min-h-[160px] px-4 py-3 text-text-primary [&_.tiptap]:outline-none [&_.tiptap_p.is-editor-empty:first-child::before]:text-text-disabled [&_.tiptap_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.tiptap_p.is-editor-empty:first-child::before]:float-left [&_.tiptap_p.is-editor-empty:first-child::before]:pointer-events-none"
              />
            </div>
          </div>

          {/* File upload */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              File attachment{" "}
              <span className="text-text-disabled font-normal">
                (optional · max 32 MB)
              </span>
            </label>

            {uploadedFileUrl ? (
              <div className="flex items-center gap-2 p-3 rounded-lg border border-border bg-surface-2">
                <FileCheck size={14} className="text-success shrink-0" />
                <span className="text-sm text-text-primary truncate flex-1">
                  {uploadedFileName ?? "File uploaded"}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setUploadedFileUrl(null);
                    setUploadedFileName(null);
                  }}
                  className="text-text-muted hover:text-danger transition-colors shrink-0"
                >
                  <X size={14} />
                </button>
              </div>
            ) : isUploading ? (
              <div className="flex items-center gap-2 p-3 rounded-lg border border-border bg-surface-2">
                <Loader2 size={14} className="animate-spin text-brand shrink-0" />
                <span className="text-sm text-text-muted">Uploading…</span>
              </div>
            ) : (
              <label className="flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border bg-surface-2 py-6 cursor-pointer hover:border-brand hover:bg-brand-light transition-colors group">
                <UploadCloud
                  size={22}
                  className="text-text-muted group-hover:text-brand transition-colors"
                />
                <div className="text-center">
                  <p className="text-sm font-medium text-text-primary">
                    Click to upload a file
                  </p>
                  <p className="text-xs text-text-muted mt-0.5">
                    Any file type · up to 32 MB
                  </p>
                </div>
                <input
                  type="file"
                  className="sr-only"
                  onChange={handleFileChange}
                />
              </label>
            )}

            {/* Show existing file from prior submission */}
            {submission?.fileUrl && !uploadedFileUrl && (
              <p className="mt-1.5 text-xs text-text-muted">
                Previously submitted file:{" "}
                <a
                  href={submission.fileUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand hover:underline"
                >
                  Download
                </a>
              </p>
            )}
          </div>

          <div className="flex justify-end pt-2 border-t border-border">
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={isSubmitting || isUploading}
              className="flex items-center gap-2 px-5 py-2 bg-brand text-white text-sm font-medium rounded-md hover:bg-brand-dark disabled:opacity-50 transition-colors"
            >
              {isSubmitting ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <CheckCircle2 size={14} />
              )}
              {submission ? "Resubmit" : "Submit Assignment"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
