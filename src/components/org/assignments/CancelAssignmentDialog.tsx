"use client";

import { useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { submitCancellation } from "@/lib/admin-assignment-client";
import type { AdminRowView } from "@/lib/admin-assignment-view";

interface CancelAssignmentDialogProps {
  /** The assignment being confirmed, or null when the dialog is closed. */
  row: AdminRowView | null;
  onClose: () => void;
  onCancelled: () => void;
  /** Radix returns focus only to a Trigger; this dialog is opened programmatically, so the caller restores it. */
  onCloseAutoFocus?: (event: Event) => void;
}

function CancelBody({
  row,
  onClose,
  onCancelled,
}: {
  row: AdminRowView;
  onClose: () => void;
  onCancelled: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const inFlight = useRef(false);

  async function confirm() {
    if (inFlight.current) return;
    inFlight.current = true;
    setIsSubmitting(true);
    setError(null);
    try {
      const result = await submitCancellation(row.id);
      if (result.kind === "error") setError(result.message);
      else onCancelled();
    } finally {
      inFlight.current = false;
      setIsSubmitting(false);
    }
  }

  return (
    <>
      <AlertDialogTitle>Cancel assignment?</AlertDialogTitle>
      <AlertDialogDescription>
        The learner will no longer see this assignment as active. They stay enrolled and keep their
        progress.
      </AlertDialogDescription>
      <p className="-mt-3 mb-4 wrap-break-word text-sm font-medium text-text-primary">
        {row.subject}
      </p>
      {error && (
        <p
          role="alert"
          className="mb-4 rounded-md border border-danger bg-danger-bg px-3 py-2 text-sm text-danger"
        >
          {error}
        </p>
      )}
      <AlertDialogFooter>
        <AlertDialogCancel disabled={isSubmitting} onClick={onClose} className="min-h-11">
          Keep assignment
        </AlertDialogCancel>
        <AlertDialogAction
          disabled={isSubmitting}
          onClick={(e) => {
            // Stay open until the request has answered, so a failure can be shown here.
            e.preventDefault();
            void confirm();
          }}
          className="min-h-11 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSubmitting ? "Cancelling…" : "Cancel assignment"}
        </AlertDialogAction>
      </AlertDialogFooter>
    </>
  );
}

export function CancelAssignmentDialog({
  row,
  onClose,
  onCancelled,
  onCloseAutoFocus,
}: CancelAssignmentDialogProps) {
  return (
    <AlertDialog open={row !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus}>
        {row && <CancelBody row={row} onClose={onClose} onCancelled={onCancelled} />}
      </AlertDialogContent>
    </AlertDialog>
  );
}
