import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { isPastCalendarDate } from "@/lib/admin-assignment-view";
import type { AssignmentOptions } from "@/lib/domain/learning-assignment/adminAssignments";
import { MAX_NOTE_LENGTH } from "@/lib/domain/learning-assignment/inputRules";

export type AssignFormValues = {
  userId: string;
  courseId: string;
  dueDate: string;
  note: string;
  learnerQuery: string;
};

export type AssignFormErrors = { userId?: string; courseId?: string };

export const EMPTY_ASSIGN_VALUES: AssignFormValues = {
  userId: "",
  courseId: "",
  dueDate: "",
  note: "",
  learnerQuery: "",
};

/** Required-field checks only; whether the pair is assignable is the server's call. */
export function validateAssignForm(values: AssignFormValues): AssignFormErrors {
  return {
    ...(values.userId ? {} : { userId: "Choose a learner." }),
    ...(values.courseId ? {} : { courseId: "Choose a course." }),
  };
}

const FIELD = "block text-sm font-medium text-text-primary mb-1.5";
const INPUT =
  "w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-text-primary placeholder:text-text-disabled focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent";
const INVALID = "border-danger focus:ring-danger";

/**
 * The learners a search leaves in the selector. The chosen learner is always
 * kept, so typing in the search box can never make the current selection vanish.
 */
export function filterLearners<T extends { id: string; name: string | null; email: string }>(
  learners: T[],
  query: string,
  selectedId: string
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return learners;
  return learners.filter(
    (l) => l.id === selectedId || `${l.name ?? ""} ${l.email}`.toLowerCase().includes(q)
  );
}

function learnerLabel(l: { name: string | null; email: string }) {
  return l.name?.trim() ? `${l.name} (${l.email})` : l.email;
}

interface AssignLearningFormProps {
  values: AssignFormValues;
  onChange: (patch: Partial<AssignFormValues>) => void;
  options: AssignmentOptions;
  errors: AssignFormErrors;
  /** A refusal or failure from the server. Announced. */
  submitError: string | null;
  /** A non-error result worth stopping for (already assigned). Announced politely. */
  notice: string | null;
  isSubmitting: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  now?: Date;
}

export function AssignLearningForm({
  values,
  onChange,
  options,
  errors,
  submitError,
  notice,
  isSubmitting,
  onSubmit,
  onCancel,
  now,
}: AssignLearningFormProps) {
  const learners = filterLearners(options.learners, values.learnerQuery, values.userId);
  const noMatch = values.learnerQuery.trim().length > 0 && learners.length === 0;
  const past = isPastCalendarDate(values.dueDate, now);

  return (
    <form
      noValidate
      aria-busy={isSubmitting}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="space-y-4"
    >
      {submitError && (
        <p
          role="alert"
          className="rounded-md border border-danger bg-danger-bg px-3 py-2 text-sm text-danger"
        >
          {submitError}
        </p>
      )}
      {notice && (
        <output className="block rounded-md border border-border bg-brand-light px-3 py-2 text-sm text-text-primary">
          {notice}
        </output>
      )}

      <div>
        <label htmlFor="assign-learner-search" className={FIELD}>
          Search learners
        </label>
        <input
          id="assign-learner-search"
          type="search"
          value={values.learnerQuery}
          onChange={(e) => onChange({ learnerQuery: e.target.value })}
          placeholder="Name or email"
          autoComplete="off"
          className={`${INPUT} min-h-11`}
        />
        {noMatch && (
          <output className="block mt-1.5 text-xs text-text-muted">
            No learners match &ldquo;{values.learnerQuery.trim()}&rdquo;.
          </output>
        )}
      </div>

      <div>
        <label htmlFor="assign-learner" className={FIELD}>
          Learner
        </label>
        <Select value={values.userId} onValueChange={(userId) => onChange({ userId })}>
          <SelectTrigger
            id="assign-learner"
            aria-invalid={errors.userId ? true : undefined}
            aria-describedby={errors.userId ? "assign-learner-error" : undefined}
            className={`min-h-11 ${errors.userId ? INVALID : ""}`}
          >
            <SelectValue
              placeholder={
                options.learners.length === 0
                  ? "No learners in your organisation"
                  : "Select a learner"
              }
            />
          </SelectTrigger>
          <SelectContent>
            {learners.map((l) => (
              <SelectItem key={l.id} value={l.id} className="min-h-11 md:min-h-8">
                {learnerLabel(l)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {errors.userId && (
          <p id="assign-learner-error" role="alert" className="mt-1.5 text-xs text-danger">
            {errors.userId}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="assign-course" className={FIELD}>
          Course
        </label>
        <Select value={values.courseId} onValueChange={(courseId) => onChange({ courseId })}>
          <SelectTrigger
            id="assign-course"
            aria-invalid={errors.courseId ? true : undefined}
            aria-describedby={errors.courseId ? "assign-course-error" : undefined}
            className={`min-h-11 ${errors.courseId ? INVALID : ""}`}
          >
            <SelectValue
              placeholder={
                options.courses.length === 0 ? "No courses available to assign" : "Select a course"
              }
            />
          </SelectTrigger>
          <SelectContent>
            {options.courses.map((c) => (
              <SelectItem key={c.id} value={c.id} className="min-h-11 md:min-h-8">
                {c.isCatalogue ? `${c.title} (catalogue)` : c.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {errors.courseId && (
          <p id="assign-course-error" role="alert" className="mt-1.5 text-xs text-danger">
            {errors.courseId}
          </p>
        )}
        <p className="mt-1.5 text-xs text-text-muted">
          Only published, free courses can be assigned.
        </p>
      </div>

      <div>
        <label htmlFor="assign-due-date" className={FIELD}>
          Due date <span className="font-normal text-text-muted">(optional)</span>
        </label>
        <input
          id="assign-due-date"
          type="date"
          value={values.dueDate}
          onChange={(e) => onChange({ dueDate: e.target.value })}
          aria-describedby={past ? "assign-due-past" : undefined}
          className={`${INPUT} min-h-11`}
        />
        {past && (
          <output id="assign-due-past" className="block mt-1.5 text-xs text-warning">
            This date has already passed, so the assignment will show as overdue straight away.
          </output>
        )}
      </div>

      <div>
        <label htmlFor="assign-note" className={FIELD}>
          Note <span className="font-normal text-text-muted">(optional)</span>
        </label>
        <textarea
          id="assign-note"
          rows={3}
          maxLength={MAX_NOTE_LENGTH}
          value={values.note}
          onChange={(e) => onChange({ note: e.target.value })}
          aria-describedby="assign-note-count"
          className={INPUT}
        />
        <p id="assign-note-count" className="mt-1 text-right text-xs text-text-muted">
          {values.note.length}/{MAX_NOTE_LENGTH}
        </p>
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="min-h-11 rounded-md px-4 py-2 text-sm font-medium text-text-muted transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={isSubmitting}
          className="min-h-11 rounded-md bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSubmitting ? "Assigning…" : "Assign"}
        </button>
      </div>
    </form>
  );
}
