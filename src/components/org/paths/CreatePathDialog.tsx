"use client";

import { useRef, useState } from "react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { type AdminFailure, type AdminPathSummary, createPath } from "@/lib/admin-path-client";
import { FailureNotice } from "./FailureNotice";
import { EMPTY_PATH_FIELDS, PathFieldsForm, validatePathFields } from "./PathFieldsForm";

interface CreatePathDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (path: AdminPathSummary) => void;
  /** Radix returns focus only to a Trigger; this dialog is opened programmatically, so the caller restores it. */
  onCloseAutoFocus?: (event: Event) => void;
}

export function CreatePathBody({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (path: AdminPathSummary) => void;
}) {
  const [values, setValues] = useState(EMPTY_PATH_FIELDS);
  const [titleError, setTitleError] = useState<string | undefined>();
  const [failure, setFailure] = useState<AdminFailure | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // A second click can land before the button re-renders as disabled; the ref closes that window.
  const inFlight = useRef(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;

    const found = validatePathFields(values);
    setTitleError(found.title);
    if (found.title) return;

    inFlight.current = true;
    setIsSubmitting(true);
    setFailure(null);
    try {
      const result = await createPath(values);
      if (result.kind === "error") setFailure(result.failure);
      else onCreated(result.data);
    } finally {
      inFlight.current = false;
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <PathFieldsForm
        idPrefix="create-path"
        values={values}
        titleError={titleError}
        disabled={isSubmitting}
        onChange={(patch) => {
          setValues((v) => ({ ...v, ...patch }));
          if (patch.title !== undefined) setTitleError(undefined);
          setFailure(null);
        }}
      />
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
          type="submit"
          disabled={isSubmitting}
          className="min-h-11 rounded-md bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSubmitting ? "Creating…" : "Create"}
        </button>
      </div>
    </form>
  );
}

/** Creates an empty draft; what it may contain and be called is the server's to decide. */
export function CreatePathDialog({
  open,
  onOpenChange,
  onCreated,
  onCloseAutoFocus,
}: CreatePathDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} onCloseAutoFocus={onCloseAutoFocus}>
        <DialogTitle>Create learning path</DialogTitle>
        {/* Mounted only while open, so every opening starts from an empty form. */}
        {open && <CreatePathBody onClose={() => onOpenChange(false)} onCreated={onCreated} />}
      </DialogContent>
    </Dialog>
  );
}
