"use client";

import { toast } from "gooey-toast";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { EmptyState } from "@/components/shared/EmptyState";
import { type AdminRowView, ASSIGNMENTS_PATH } from "@/lib/admin-assignment-view";
import type { AssignmentOptions } from "@/lib/domain/learning-assignment/adminAssignments";
import { AssignLearningDialog, type AssignSuccess } from "./AssignLearningDialog";
import { AssignmentList } from "./AssignmentList";
import { CancelAssignmentDialog } from "./CancelAssignmentDialog";

interface AssignmentsClientProps {
  rows: AdminRowView[];
  options: AssignmentOptions;
  /** True when a source or status filter is applied. */
  filtered: boolean;
  /** The next, older page of the same filtered list; null on the last page. */
  olderHref: string | null;
  /** The newest page of the same filtered list; null when this already is it. */
  newestHref: string | null;
}

const LINK_BUTTON =
  "inline-flex min-h-11 items-center justify-center rounded-md border border-border bg-white px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";

const ASSIGN_TOASTS: Record<AssignSuccess, string> = {
  created: "Learning assigned",
  updated: "Due date updated",
  reactivated: "Assignment reactivated",
};

/**
 * Puts focus back where the person was when they opened a dialog. If that
 * element has since been removed (a cancelled row loses its button), it goes to
 * the page's primary action instead, so keyboard focus is never dropped on <body>.
 */
function restoreFocus(opener: HTMLElement | null, fallback: HTMLElement | null, event: Event) {
  event.preventDefault();
  (opener?.isConnected ? opener : fallback)?.focus();
}

export function AssignmentsClient({
  rows,
  options,
  filtered,
  olderHref,
  newestHref,
}: AssignmentsClientProps) {
  const router = useRouter();
  const [assignOpen, setAssignOpen] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<AdminRowView | null>(null);
  const assignButton = useRef<HTMLButtonElement>(null);
  const assignOpener = useRef<HTMLElement | null>(null);
  const cancelOpener = useRef<HTMLElement | null>(null);

  function openAssign() {
    assignOpener.current = document.activeElement as HTMLElement | null;
    setAssignOpen(true);
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button
          ref={assignButton}
          type="button"
          onClick={openAssign}
          className="inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-md bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand sm:w-auto"
        >
          <Plus size={16} aria-hidden="true" />
          Assign learning
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-surface-1">
          {newestHref ? (
            <div className="flex flex-col items-center px-4 py-10 text-center">
              <h3 className="mb-1 text-base font-semibold text-text-primary">
                No more assignments
              </h3>
              <p className="mb-4 max-w-xs text-sm text-text-muted">
                There is nothing older than the last page you were on.
              </p>
              <Link href={newestHref} className={LINK_BUTTON}>
                Back to the newest
              </Link>
            </div>
          ) : filtered ? (
            <div className="flex flex-col items-center px-4 py-10 text-center">
              <h3 className="mb-1 text-base font-semibold text-text-primary">
                No assignments match these filters
              </h3>
              <p className="mb-4 max-w-xs text-sm text-text-muted">
                Try a different source or status, or clear the filters.
              </p>
              <Link href={ASSIGNMENTS_PATH} className={LINK_BUTTON}>
                Clear filters
              </Link>
            </div>
          ) : (
            <EmptyState
              title="No assignments yet"
              description="Assign a course to a learner and it will appear here with its status."
              ctaLabel="Assign learning"
              onCta={openAssign}
            />
          )}
        </div>
      ) : (
        <>
          <AssignmentList
            rows={rows}
            onCancel={(row) => {
              cancelOpener.current = document.activeElement as HTMLElement | null;
              setCancelTarget(row);
            }}
          />
          {(olderHref || newestHref) && (
            <nav
              aria-label="Assignment pages"
              className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <p className="text-xs text-text-muted">
                {olderHref
                  ? `Showing ${rows.length} assignments. Older ones match too: use Older assignments to see them.`
                  : `Showing the last ${rows.length} assignments of this list.`}
              </p>
              <div className="flex flex-wrap gap-2">
                {newestHref && (
                  <Link href={newestHref} className={LINK_BUTTON}>
                    Newest assignments
                  </Link>
                )}
                {olderHref && (
                  <Link href={olderHref} className={LINK_BUTTON}>
                    Older assignments
                  </Link>
                )}
              </div>
            </nav>
          )}
        </>
      )}

      <AssignLearningDialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        options={options}
        onCloseAutoFocus={(e) => restoreFocus(assignOpener.current, assignButton.current, e)}
        onSuccess={(kind) => {
          toast.success({ title: ASSIGN_TOASTS[kind] });
          setAssignOpen(false);
          router.refresh();
        }}
      />

      <CancelAssignmentDialog
        row={cancelTarget}
        onCloseAutoFocus={(e) => restoreFocus(cancelOpener.current, assignButton.current, e)}
        onClose={() => setCancelTarget(null)}
        onCancelled={() => {
          toast.success({ title: "Assignment cancelled" });
          setCancelTarget(null);
          router.refresh();
        }}
      />
    </div>
  );
}
