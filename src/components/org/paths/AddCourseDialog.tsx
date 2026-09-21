"use client";

import { Check, Plus, Search } from "lucide-react";
import { useRef, useState } from "react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { AdminFailure, PathCourseChoice } from "@/lib/admin-path-client";
import { FailureNotice } from "./FailureNotice";
import { PathStatusBadge } from "./PathStatusBadge";

interface AddCourseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The organisation's courses to choose from; the server still decides what may join. */
  choices: readonly PathCourseChoice[];
  /** Courses already in the path, as the screen last read it. */
  memberIds: ReadonlySet<string>;
  /** Resolves to the refusal, or null when the course was added. */
  onAdd: (courseId: string) => Promise<AdminFailure | null>;
  onCloseAutoFocus?: (event: Event) => void;
}

/** Search is within the courses the page was given: there is no course search API to ask. */
export function filterChoices(choices: readonly PathCourseChoice[], query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...choices];
  return choices.filter(
    (c) => c.title.toLowerCase().includes(needle) || c.slug.toLowerCase().includes(needle)
  );
}

export function AddCourseBody({
  choices,
  memberIds,
  onAdd,
  onClose,
}: Pick<AddCourseDialogProps, "choices" | "memberIds" | "onAdd"> & { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [failure, setFailure] = useState<AdminFailure | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);
  const inFlight = useRef(false);

  const shown = filterChoices(choices, query);

  async function add(courseId: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setAddingId(courseId);
    setFailure(null);
    try {
      setFailure(await onAdd(courseId));
    } finally {
      inFlight.current = false;
      setAddingId(null);
    }
  }

  return (
    <div className="space-y-4">
      <DialogTitle className="mb-0">Add a course</DialogTitle>

      <div>
        <label
          htmlFor="add-course-search"
          className="mb-1.5 block text-sm font-medium text-text-primary"
        >
          Search your courses
        </label>
        <div className="relative">
          <Search
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
            aria-hidden="true"
          />
          <input
            id="add-course-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Course title"
            className="w-full rounded-md border border-border bg-white py-2 pl-9 pr-3 text-sm text-text-primary placeholder:text-text-disabled focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand"
          />
        </div>
      </div>

      {failure && <FailureNotice failure={failure} />}

      <output aria-live="polite" className="block text-xs text-text-muted">
        {choices.length === 0
          ? "Your organisation has no courses to add yet."
          : `${shown.length} of ${choices.length} courses`}
      </output>

      {shown.length > 0 && (
        <ul className="max-h-72 space-y-2 overflow-y-auto pr-1">
          {shown.map((course) => {
            const isMember = memberIds.has(course.id);
            return (
              <li
                key={course.id}
                className="flex items-center gap-3 rounded-md border border-border bg-surface-1 p-2.5"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="wrap-break-word text-sm font-medium text-text-primary">
                    {course.title}
                  </p>
                  <PathStatusBadge
                    status={course.status}
                    label={`Course ${course.status.toLowerCase()}`}
                  />
                </div>
                {isMember ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-success">
                    <Check size={14} aria-hidden="true" />
                    In this path
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => void add(course.id)}
                    disabled={addingId !== null}
                    aria-label={`Add ${course.title} to this path`}
                    className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-md bg-brand px-3 text-sm font-medium text-white transition-colors hover:bg-brand-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50 md:min-h-9"
                  >
                    <Plus size={14} aria-hidden="true" />
                    {addingId === course.id ? "Adding…" : "Add"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="min-h-11 rounded-md border border-border bg-white px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          Done
        </button>
      </div>
    </div>
  );
}

export function AddCourseDialog({
  open,
  onOpenChange,
  choices,
  memberIds,
  onAdd,
  onCloseAutoFocus,
}: AddCourseDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} onCloseAutoFocus={onCloseAutoFocus}>
        {open && (
          <AddCourseBody
            choices={choices}
            memberIds={memberIds}
            onAdd={onAdd}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
