"use client";

import { useState } from "react";
import { format } from "date-fns";
import {
  ExternalLink,
  Loader2,
  CheckCircle2,
  ClipboardList,
} from "lucide-react";
import { toast } from "gooey-toast";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";

export interface SubmissionItem {
  id: string;
  status: "SUBMITTED" | "LATE";
  textContent: string | null;
  fileUrl: string | null;
  submittedAt: string;
  studentName: string | null;
  studentEmail: string;
  assignmentId: string;
  assignmentTitle: string;
  maxScore: number;
  courseTitle: string;
  lessonTitle: string;
}

const STATUS_CONFIG = {
  SUBMITTED: { label: "Submitted", className: "bg-brand-light text-brand" },
  LATE: { label: "Late", className: "bg-warning-bg text-warning" },
} as const;

function ReadonlySubmission({ html }: { html: string }) {
  const editor = useEditor({
    extensions: [StarterKit],
    content: html,
    editable: false,
    immediatelyRender: false,
  });

  if (!editor) {
    return <div className="min-h-[80px] rounded bg-surface-2 animate-pulse" />;
  }

  return (
    <EditorContent
      editor={editor}
      className="prose prose-sm max-w-none text-text-primary [&_.tiptap]:outline-none"
    />
  );
}

interface GradingFormProps {
  submission: SubmissionItem;
  onGraded: (submissionId: string) => void;
  onClose: () => void;
}

function GradingForm({ submission, onGraded, onClose }: GradingFormProps) {
  const [score, setScore] = useState<number | "">("");
  const [feedback, setFeedback] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleGrade() {
    if (score === "" || score < 0) {
      toast.error({ title: "Enter a valid score." });
      return;
    }
    if (score > submission.maxScore) {
      toast.error({
        title: `Score cannot exceed ${submission.maxScore}.`,
      });
      return;
    }
    setIsSubmitting(true);
    try {
      const res = await fetch(
        `/api/assignments/${submission.assignmentId}/submissions/${submission.id}/grade`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            score: Number(score),
            feedback: feedback.trim() || null,
          }),
        },
      );
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        toast.error({ title: data.error ?? "Failed to submit grade." });
        return;
      }
      toast.success({ title: "Grade submitted." });
      onGraded(submission.id);
      onClose();
    } catch {
      toast.error({ title: "Failed to submit grade. Please try again." });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Meta */}
      <div className="text-sm text-text-muted space-y-0.5">
        <p>
          <span className="font-medium text-text-primary">
            {submission.studentName ?? submission.studentEmail}
          </span>
          {" · "}
          {submission.courseTitle}
        </p>
        <p className="text-xs">
          {submission.lessonTitle} — {submission.assignmentTitle}
        </p>
        <p className="text-xs">
          Submitted {format(new Date(submission.submittedAt), "MMM d, yyyy 'at' h:mm a")}
          {" "}
          <span
            className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${STATUS_CONFIG[submission.status].className}`}
          >
            {STATUS_CONFIG[submission.status].label}
          </span>
        </p>
      </div>

      {/* Written submission */}
      {submission.textContent && (
        <div>
          <p className="text-xs font-medium text-text-secondary mb-1.5">
            Written response
          </p>
          <div className="rounded-lg border border-border bg-surface-2 p-4 max-h-64 overflow-y-auto">
            <ReadonlySubmission html={submission.textContent} />
          </div>
        </div>
      )}

      {/* File */}
      {submission.fileUrl && (
        <div>
          <p className="text-xs font-medium text-text-secondary mb-1.5">
            Attachment
          </p>
          <a
            href={submission.fileUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-brand hover:underline"
          >
            <ExternalLink size={13} />
            Download file
          </a>
        </div>
      )}

      <div className="border-t border-border pt-4 space-y-3">
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">
            Score{" "}
            <span className="text-text-disabled font-normal">
              (out of {submission.maxScore})
            </span>
          </label>
          <input
            type="number"
            value={score}
            min={0}
            max={submission.maxScore}
            onChange={(e) =>
              setScore(e.target.value === "" ? "" : Number(e.target.value))
            }
            placeholder={`0 – ${submission.maxScore}`}
            className="w-full border border-border rounded-md px-3 py-2 text-sm text-text-primary bg-surface-1 focus:outline-none focus:border-brand"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">
            Feedback{" "}
            <span className="text-text-disabled font-normal">(optional)</span>
          </label>
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={3}
            placeholder="Leave a note for the student…"
            className="w-full border border-border rounded-md px-3 py-2 text-sm text-text-primary bg-surface-1 focus:outline-none focus:border-brand resize-none"
          />
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1.5 text-sm text-text-muted border border-border rounded-md hover:bg-surface-2 transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void handleGrade()}
          disabled={isSubmitting || score === ""}
          className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium bg-brand text-white rounded-md hover:bg-brand-dark disabled:opacity-50 transition-colors"
        >
          {isSubmitting ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <CheckCircle2 size={13} />
          )}
          Submit grade
        </button>
      </div>
    </div>
  );
}

interface SubmissionsGraderProps {
  initialSubmissions: SubmissionItem[];
}

export function SubmissionsGrader({
  initialSubmissions,
}: SubmissionsGraderProps) {
  const [submissions, setSubmissions] =
    useState<SubmissionItem[]>(initialSubmissions);
  const [activeSubmission, setActiveSubmission] =
    useState<SubmissionItem | null>(null);

  function removeGraded(submissionId: string) {
    setSubmissions((prev) => prev.filter((s) => s.id !== submissionId));
  }

  if (submissions.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-surface-2 py-12 text-center">
        <ClipboardList size={28} className="text-text-disabled mx-auto mb-2" />
        <p className="text-sm font-medium text-text-primary mb-1">
          All caught up!
        </p>
        <p className="text-xs text-text-muted">
          No submissions waiting for a grade.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-2">
        {submissions.map((sub) => (
          <button
            key={sub.id}
            type="button"
            onClick={() => setActiveSubmission(sub)}
            className="w-full flex items-center justify-between gap-4 p-4 bg-surface-1 border border-border rounded-lg hover:border-brand hover:bg-brand-light transition-colors text-left group"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium text-text-primary truncate">
                {sub.studentName ?? sub.studentEmail}
              </p>
              <p className="text-xs text-text-muted truncate">
                {sub.courseTitle} — {sub.assignmentTitle}
              </p>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <span className="text-xs text-text-muted">
                {format(new Date(sub.submittedAt), "MMM d")}
              </span>
              <span
                className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${STATUS_CONFIG[sub.status].className}`}
              >
                {STATUS_CONFIG[sub.status].label}
              </span>
            </div>
          </button>
        ))}
      </div>

      <Dialog
        open={!!activeSubmission}
        onOpenChange={(open) => {
          if (!open) setActiveSubmission(null);
        }}
      >
        <DialogContent>
          <DialogTitle>Grade submission</DialogTitle>
          {activeSubmission && (
            <GradingForm
              submission={activeSubmission}
              onGraded={removeGraded}
              onClose={() => setActiveSubmission(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
