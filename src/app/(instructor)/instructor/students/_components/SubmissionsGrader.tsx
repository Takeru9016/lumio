"use client";

import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { format } from "date-fns";
import { toast } from "gooey-toast";
import { CheckCircle2, ClipboardList, ExternalLink, Loader2, Sparkles } from "lucide-react";
import { useState } from "react";

import { AiBadge } from "@/components/shared/AiBadge";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

interface AssessmentDraft {
  suggestedScore: number;
  feedback: string;
  rationale: string;
  citations: string[];
}

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
  const [aiDraft, setAiDraft] = useState<AssessmentDraft | null>(null);
  const [aiLoading, setAiLoading] = useState(false);

  async function handleSuggestGrade() {
    // Single-flight: a second click while a request is already in flight is
    // a no-op (the button is also disabled meanwhile). Switching to a
    // different submission remounts this component fresh (see the `key`
    // prop below), so a stale response can never populate another
    // submission's form — there is no shared state for it to write into.
    if (aiLoading) return;
    setAiLoading(true);
    setAiDraft(null);
    try {
      const res = await fetch(
        `/api/ai/assignments/${submission.assignmentId}/submissions/${submission.id}/suggest-grade`,
        { method: "POST" }
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error({ title: data.error ?? "Failed to generate a suggestion." });
        return;
      }
      const draft = (await res.json()) as AssessmentDraft;
      setAiDraft(draft);
    } catch {
      toast.error({ title: "Failed to generate a suggestion. Please try again." });
    } finally {
      setAiLoading(false);
    }
  }

  // Pre-fills the existing manual fields only — this NEVER calls the grade
  // endpoint. The instructor still has to press the unchanged "Submit
  // grade" button below to commit anything.
  function useSuggestion() {
    if (!aiDraft) return;
    setScore(aiDraft.suggestedScore);
    setFeedback(aiDraft.feedback);
  }

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
        }
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
          Submitted {format(new Date(submission.submittedAt), "MMM d, yyyy 'at' h:mm a")}{" "}
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
          <p className="text-xs font-medium text-text-secondary mb-1.5">Written response</p>
          <div className="rounded-lg border border-border bg-surface-2 p-4 max-h-64 overflow-y-auto">
            <ReadonlySubmission html={submission.textContent} />
          </div>
        </div>
      )}

      {/* File */}
      {submission.fileUrl && (
        <div>
          <p className="text-xs font-medium text-text-secondary mb-1.5">Attachment</p>
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

      <div className="border-t border-border pt-4">
        <button
          type="button"
          onClick={() => void handleSuggestGrade()}
          disabled={aiLoading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-ai border border-ai-border rounded-md hover:bg-ai-bg disabled:opacity-50 transition-colors"
        >
          {aiLoading ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
          Suggest grade
        </button>

        {aiDraft && (
          <div className="mt-3 rounded-lg border border-ai-border bg-ai-bg p-4 space-y-3">
            <AiBadge label="AI-generated suggestion — review before grading" size="md" />

            <div>
              <p className="text-xs font-medium text-text-secondary mb-1">
                Suggested score{" "}
                <span className="text-text-disabled font-normal">
                  (out of {submission.maxScore})
                </span>
              </p>
              <p className="text-sm text-text-primary">{aiDraft.suggestedScore}</p>
            </div>

            <div>
              <p className="text-xs font-medium text-text-secondary mb-1">Suggested feedback</p>
              <p className="text-sm text-text-primary whitespace-pre-wrap">{aiDraft.feedback}</p>
            </div>

            <div className="rounded-md bg-surface-1 border border-border p-2">
              <p className="text-xs font-medium text-text-secondary mb-1">Rationale</p>
              <p className="text-xs text-text-muted whitespace-pre-wrap">{aiDraft.rationale}</p>
            </div>

            {aiDraft.citations.length > 0 && (
              <p className="text-xs text-text-disabled">Based on: {aiDraft.citations.join(", ")}</p>
            )}

            <div className="flex justify-end">
              <button
                type="button"
                onClick={useSuggestion}
                className="px-3 py-1.5 text-xs font-medium bg-ai text-white rounded-md hover:opacity-90 transition-colors"
              >
                Use suggestion
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-border pt-4 space-y-3">
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">
            Score{" "}
            <span className="text-text-disabled font-normal">(out of {submission.maxScore})</span>
          </label>
          <input
            type="number"
            value={score}
            min={0}
            max={submission.maxScore}
            onChange={(e) => setScore(e.target.value === "" ? "" : Number(e.target.value))}
            placeholder={`0 – ${submission.maxScore}`}
            className="w-full border border-border rounded-md px-3 py-2 text-sm text-text-primary bg-surface-1 focus:outline-none focus:border-brand"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">
            Feedback <span className="text-text-disabled font-normal">(optional)</span>
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

export function SubmissionsGrader({ initialSubmissions }: SubmissionsGraderProps) {
  const [submissions, setSubmissions] = useState<SubmissionItem[]>(initialSubmissions);
  const [activeSubmission, setActiveSubmission] = useState<SubmissionItem | null>(null);

  function removeGraded(submissionId: string) {
    setSubmissions((prev) => prev.filter((s) => s.id !== submissionId));
  }

  if (submissions.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-surface-2 py-12 text-center">
        <ClipboardList size={28} className="text-text-disabled mx-auto mb-2" />
        <p className="text-sm font-medium text-text-primary mb-1">All caught up!</p>
        <p className="text-xs text-text-muted">No submissions waiting for a grade.</p>
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
              key={activeSubmission.id}
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
