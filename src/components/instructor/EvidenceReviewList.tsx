"use client";

import { format } from "date-fns";
import { toast } from "gooey-toast";
import { CheckCircle2, ShieldCheck, XCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

type EvidenceType = "COURSE_COMPLETION" | "QUIZ_SCORE" | "ASSESSMENT" | string;
type VerificationStatus = "UNVERIFIED" | "PENDING" | "VERIFIED" | "REJECTED";

export interface ReviewableEvidenceItem {
  id: string;
  skillId: string;
  skillName: string;
  type: EvidenceType;
  sourceType: string;
  score: number | null;
  verificationStatus: VerificationStatus;
  courseTitle: string;
  createdAt: string | Date;
}

interface EvidenceReviewListProps {
  initialEvidence: ReviewableEvidenceItem[];
}

const TYPE_LABEL: Record<string, string> = {
  COURSE_COMPLETION: "Course completion",
  QUIZ_SCORE: "Quiz score",
  ASSESSMENT: "Assignment grade",
};

const STATUS_CONFIG: Record<VerificationStatus, { label: string; className: string }> = {
  UNVERIFIED: { label: "Unverified", className: "bg-surface-3 text-text-muted" },
  PENDING: { label: "Pending", className: "bg-warning-bg text-warning" },
  VERIFIED: { label: "Verified", className: "bg-success-bg text-success" },
  REJECTED: { label: "Rejected", className: "bg-danger-bg text-danger" },
};

export function EvidenceReviewList({ initialEvidence }: EvidenceReviewListProps) {
  const router = useRouter();
  // A Set (not a single id) so two different rows can be in flight
  // independently — a single shared id would re-enable an earlier row's
  // buttons the moment a second row started processing.
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set());

  async function handleDecision(evidenceId: string, action: "verify" | "reject") {
    // Single-flight per row: a duplicate call for a row already in flight is
    // a no-op; every other row remains independently actionable. The server
    // response is the only source of truth for the resulting state
    // (router.refresh() below), never an optimistic local update.
    if (processingIds.has(evidenceId)) return;
    setProcessingIds((prev) => new Set(prev).add(evidenceId));
    try {
      const res = await fetch(`/api/capability/evidence/${evidenceId}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Couldn't update evidence");
      toast.success({ title: action === "verify" ? "Evidence verified" : "Evidence rejected" });
      router.refresh();
    } catch (err) {
      toast.error({ title: err instanceof Error ? err.message : "Couldn't update evidence" });
    } finally {
      setProcessingIds((prev) => {
        const next = new Set(prev);
        next.delete(evidenceId);
        return next;
      });
    }
  }

  if (initialEvidence.length === 0) {
    return (
      <div className="px-4 py-6 text-center">
        <ShieldCheck size={20} className="text-text-disabled mx-auto mb-2" />
        <p className="text-sm text-text-muted">No skill evidence to review yet.</p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-border">
      {initialEvidence.map((item) => {
        const status = STATUS_CONFIG[item.verificationStatus] ?? STATUS_CONFIG.UNVERIFIED;
        const isProcessing = processingIds.has(item.id);
        return (
          <div key={item.id} className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-text-primary truncate">{item.skillName}</p>
              <p className="text-xs text-text-muted truncate">
                {TYPE_LABEL[item.type] ?? item.type} — {item.courseTitle}
                {item.score != null && ` · ${item.score}%`}
              </p>
              <p className="text-xs text-text-disabled mt-0.5">
                {format(new Date(item.createdAt), "MMM d, yyyy")}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${status.className}`}>
                {status.label}
              </span>
              {item.verificationStatus === "UNVERIFIED" && (
                <>
                  <button
                    type="button"
                    onClick={() => handleDecision(item.id, "verify")}
                    disabled={isProcessing}
                    className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-success border border-border rounded-md hover:bg-success-bg disabled:opacity-50 transition-colors"
                  >
                    <CheckCircle2 size={13} />
                    Verify
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDecision(item.id, "reject")}
                    disabled={isProcessing}
                    className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-danger border border-border rounded-md hover:bg-danger-bg disabled:opacity-50 transition-colors"
                  >
                    <XCircle size={13} />
                    Reject
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
