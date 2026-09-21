import type { PathFields } from "@/lib/admin-path-client";
import {
  LEARNING_PATH_DESCRIPTION_MAX_LENGTH,
  LEARNING_PATH_TITLE_MAX_LENGTH,
} from "@/lib/domain/learning-path/constants";

export const EMPTY_PATH_FIELDS: PathFields = { title: "", description: "" };

/** Only what a person can see is wrong without asking the server; the server's rules stay the real ones. */
export function validatePathFields(values: PathFields): { title?: string } {
  return values.title.trim().length === 0 ? { title: "Enter a title for this path." } : {};
}

const INPUT =
  "w-full rounded-md border bg-white px-3 py-2 text-sm text-text-primary placeholder:text-text-disabled focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-text-muted";

interface PathFieldsFormProps {
  /** Prefixes the input ids so two forms on one page never share a label target. */
  idPrefix: string;
  values: PathFields;
  onChange: (patch: Partial<PathFields>) => void;
  titleError?: string;
  disabled?: boolean;
}

export function PathFieldsForm({
  idPrefix,
  values,
  onChange,
  titleError,
  disabled = false,
}: PathFieldsFormProps) {
  const titleId = `${idPrefix}-title`;
  const descriptionId = `${idPrefix}-description`;

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor={titleId} className="mb-1.5 block text-sm font-medium text-text-primary">
          Title
        </label>
        <input
          id={titleId}
          type="text"
          required
          maxLength={LEARNING_PATH_TITLE_MAX_LENGTH}
          value={values.title}
          disabled={disabled}
          aria-invalid={titleError ? true : undefined}
          aria-describedby={titleError ? `${titleId}-error` : undefined}
          onChange={(e) => onChange({ title: e.target.value })}
          placeholder="Leadership foundations"
          className={`${INPUT} ${
            titleError
              ? "border-danger focus:ring-danger"
              : "border-border focus:border-transparent focus:ring-brand"
          }`}
        />
        {titleError && (
          <p id={`${titleId}-error`} className="mt-1 text-xs text-danger">
            {titleError}
          </p>
        )}
      </div>

      <div>
        <label
          htmlFor={descriptionId}
          className="mb-1.5 block text-sm font-medium text-text-primary"
        >
          Description <span className="font-normal text-text-muted">(optional)</span>
        </label>
        <textarea
          id={descriptionId}
          rows={3}
          maxLength={LEARNING_PATH_DESCRIPTION_MAX_LENGTH}
          value={values.description}
          disabled={disabled}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder="What learners will be able to do after this path."
          className={`${INPUT} resize-y border-border focus:border-transparent focus:ring-brand`}
        />
      </div>
    </div>
  );
}
