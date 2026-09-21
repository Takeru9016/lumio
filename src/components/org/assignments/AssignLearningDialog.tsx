"use client";

import { useRef, useState } from "react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { submitManualAssignment } from "@/lib/admin-assignment-client";
import type { AssignmentOptions } from "@/lib/domain/learning-assignment/adminAssignments";
import {
  type AssignFormErrors,
  type AssignFormValues,
  AssignLearningForm,
  EMPTY_ASSIGN_VALUES,
  validateAssignForm,
} from "./AssignLearningForm";

export type AssignSuccess = "created" | "updated" | "reactivated";

interface AssignLearningDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options: AssignmentOptions;
  /** Called after the server accepted the request and the dialog should close. */
  onSuccess: (kind: AssignSuccess) => void;
  /** Radix returns focus only to a Trigger; this dialog is opened programmatically, so the caller restores it. */
  onCloseAutoFocus?: (event: Event) => void;
}

/**
 * Owns the submission: validation of the two required choices, the request, and
 * what each answer means to the person. Eligibility is never decided here; a
 * refusal comes back from the server and is shown as its message.
 *
 * `existing` deliberately keeps the dialog open with a notice instead of
 * pretending something was created: the learner already has this course.
 */
function AssignLearningBody({
  options,
  onClose,
  onSuccess,
}: Omit<AssignLearningDialogProps, "open" | "onOpenChange"> & { onClose: () => void }) {
  const [values, setValues] = useState<AssignFormValues>(EMPTY_ASSIGN_VALUES);
  const [errors, setErrors] = useState<AssignFormErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // State updates are asynchronous; a second click can land before the button
  // re-renders as disabled. The ref closes that window.
  const inFlight = useRef(false);

  function change(patch: Partial<AssignFormValues>) {
    setValues((v) => ({ ...v, ...patch }));
    setErrors((e) => ({
      ...e,
      ...(patch.userId ? { userId: undefined } : {}),
      ...(patch.courseId ? { courseId: undefined } : {}),
    }));
    setSubmitError(null);
    setNotice(null);
  }

  async function submit() {
    if (inFlight.current) return;

    const found = validateAssignForm(values);
    setErrors(found);
    if (found.userId || found.courseId) return;

    inFlight.current = true;
    setIsSubmitting(true);
    setSubmitError(null);
    setNotice(null);
    try {
      const result = await submitManualAssignment(values);
      if (result.kind === "error") {
        setSubmitError(result.message);
      } else if (result.kind === "existing") {
        setNotice("This learner is already assigned this course.");
      } else {
        onSuccess(result.kind);
      }
    } finally {
      inFlight.current = false;
      setIsSubmitting(false);
    }
  }

  return (
    <AssignLearningForm
      values={values}
      onChange={change}
      options={options}
      errors={errors}
      submitError={submitError}
      notice={notice}
      isSubmitting={isSubmitting}
      onSubmit={submit}
      onCancel={onClose}
    />
  );
}

export function AssignLearningDialog({
  open,
  onOpenChange,
  options,
  onSuccess,
  onCloseAutoFocus,
}: AssignLearningDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} onCloseAutoFocus={onCloseAutoFocus}>
        <DialogTitle>Assign learning</DialogTitle>
        {/* Mounted only while open, so every opening starts from an empty form. */}
        {open && (
          <AssignLearningBody
            options={options}
            onClose={() => onOpenChange(false)}
            onSuccess={onSuccess}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
