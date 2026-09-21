"use client";

import { useRef, useState } from "react";

import type { AdminFailure, PathFields } from "@/lib/admin-path-client";
import { FailureNotice } from "./FailureNotice";
import { PathFieldsForm, validatePathFields } from "./PathFieldsForm";

interface PathMetadataFormProps {
  /** What the server holds now; the form is remounted when this changes. */
  initial: PathFields;
  /** Another change is being saved. */
  busy: boolean;
  /** Resolves to the refusal, or null when it was saved. */
  onSave: (fields: PathFields) => Promise<AdminFailure | null>;
}

/** Edits a draft's or published path's title and description. The server's rules are the real ones. */
export function PathMetadataForm({ initial, busy, onSave }: PathMetadataFormProps) {
  const [values, setValues] = useState(initial);
  const [titleError, setTitleError] = useState<string | undefined>();
  const [failure, setFailure] = useState<AdminFailure | null>(null);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);

  const dirty = values.title !== initial.title || values.description !== initial.description;
  const disabled = saving || busy;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (inFlight.current || busy) return;

    const found = validatePathFields(values);
    setTitleError(found.title);
    if (found.title) return;

    inFlight.current = true;
    setSaving(true);
    setFailure(null);
    try {
      setFailure(await onSave(values));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <PathFieldsForm
        idPrefix="edit-path"
        values={values}
        titleError={titleError}
        disabled={disabled}
        onChange={(patch) => {
          setValues((v) => ({ ...v, ...patch }));
          if (patch.title !== undefined) setTitleError(undefined);
          setFailure(null);
        }}
      />
      {failure && <FailureNotice failure={failure} />}
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={disabled || !dirty}
          className="min-h-11 w-full rounded-md bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
        >
          {saving ? "Saving…" : "Save details"}
        </button>
      </div>
    </form>
  );
}
