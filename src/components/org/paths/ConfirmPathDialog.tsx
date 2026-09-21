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
import type { AdminFailure } from "@/lib/admin-path-client";
import { FailureNotice } from "./FailureNotice";

export interface ConfirmCopy {
  title: string;
  description: string;
  /** Names what is being confirmed, e.g. the course being removed. */
  subject?: string;
  confirmLabel: string;
  pendingLabel: string;
  cancelLabel: string;
}

interface ConfirmPathDialogProps {
  /** What is being confirmed, or null when the dialog is closed. */
  copy: ConfirmCopy | null;
  /** Resolves to the refusal, or null when it went through. */
  onConfirm: () => Promise<AdminFailure | null>;
  onClose: () => void;
  /** Radix returns focus only to a Trigger; this dialog is opened programmatically, so the caller restores it. */
  onCloseAutoFocus?: (event: Event) => void;
}

export function ConfirmBody({
  copy,
  onConfirm,
  onClose,
}: {
  copy: ConfirmCopy;
  onConfirm: () => Promise<AdminFailure | null>;
  onClose: () => void;
}) {
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

  return (
    <>
      <AlertDialogTitle>{copy.title}</AlertDialogTitle>
      <AlertDialogDescription>{copy.description}</AlertDialogDescription>
      {copy.subject && (
        <p className="-mt-3 mb-4 wrap-break-word text-sm font-medium text-text-primary">
          {copy.subject}
        </p>
      )}
      {failure && (
        <div className="mb-4">
          <FailureNotice failure={failure} />
        </div>
      )}
      <AlertDialogFooter className="flex-col-reverse sm:flex-row">
        <AlertDialogCancel disabled={isSubmitting} onClick={onClose} className="min-h-11">
          {copy.cancelLabel}
        </AlertDialogCancel>
        <AlertDialogAction
          disabled={isSubmitting}
          onClick={(event) => {
            // Stay open until the request has answered, so a refusal can be shown here.
            event.preventDefault();
            void confirm();
          }}
          className="min-h-11 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSubmitting ? copy.pendingLabel : copy.confirmLabel}
        </AlertDialogAction>
      </AlertDialogFooter>
    </>
  );
}

/** The existing confirmation dialog, for the two changes that take something away from learners or the path. */
export function ConfirmPathDialog({
  copy,
  onConfirm,
  onClose,
  onCloseAutoFocus,
}: ConfirmPathDialogProps) {
  return (
    <AlertDialog open={copy !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus}>
        {copy && <ConfirmBody copy={copy} onConfirm={onConfirm} onClose={onClose} />}
      </AlertDialogContent>
    </AlertDialog>
  );
}
