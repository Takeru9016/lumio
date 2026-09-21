"use client";

import { useRef, useState } from "react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { AdminFailure } from "@/lib/admin-path-client";
import { FailureNotice } from "./FailureNotice";

interface PublishPathDialogProps {
  open: boolean;
  /** True when the path is archived and this makes it live again. */
  republish: boolean;
  pathTitle: string;
  /** Resolves to the refusal (with any blocking courses), or null when it was published. */
  onConfirm: () => Promise<AdminFailure | null>;
  onClose: () => void;
  onCloseAutoFocus?: (event: Event) => void;
}

export function PublishBody({
  republish,
  pathTitle,
  onConfirm,
  onClose,
}: Omit<PublishPathDialogProps, "open" | "onCloseAutoFocus">) {
  const [failure, setFailure] = useState<AdminFailure | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const inFlight = useRef(false);

  async function confirm() {
    if (inFlight.current) return;
    inFlight.current = true;
    setIsSubmitting(true);
    setFailure(null);
    try {
      const refusal = await onConfirm();
      if (refusal) setFailure(refusal);
      else onClose();
    } finally {
      inFlight.current = false;
      setIsSubmitting(false);
    }
  }

  const verb = republish ? "Republish" : "Publish";

  return (
    <div className="space-y-4">
      <DialogTitle className="mb-0">{`${verb} this learning path?`}</DialogTitle>
      <p className="text-sm text-text-muted">
        {republish
          ? "Learners in your organisation will see this path again, with their progress as it stands now."
          : "Learners in your organisation will be able to see this path and its courses."}
      </p>
      <p className="wrap-break-word text-sm font-medium text-text-primary">{pathTitle}</p>
      <p className="text-xs text-text-muted">
        The path is checked when you {verb.toLowerCase()} it. If a course is not ready, you will see
        which one.
      </p>
      {failure && <FailureNotice failure={failure} />}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button
          type="button"
          onClick={onClose}
          disabled={isSubmitting}
          className="min-h-11 rounded-md border border-border bg-white px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void confirm()}
          disabled={isSubmitting}
          className="min-h-11 rounded-md bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSubmitting ? `${verb}ing…` : verb}
        </button>
      </div>
    </div>
  );
}

/**
 * Publish and republish share one request; the server checks the whole path and
 * answers with the courses that stop it. This dialog only asks, and shows that answer.
 */
export function PublishPathDialog({
  open,
  republish,
  pathTitle,
  onConfirm,
  onClose,
  onCloseAutoFocus,
}: PublishPathDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent aria-describedby={undefined} onCloseAutoFocus={onCloseAutoFocus}>
        {open && (
          <PublishBody
            republish={republish}
            pathTitle={pathTitle}
            onConfirm={onConfirm}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
