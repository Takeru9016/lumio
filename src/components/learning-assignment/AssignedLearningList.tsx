import { ArrowRight } from "lucide-react";
import Link from "next/link";

import { EmptyState } from "@/components/shared/EmptyState";
import {
  type AssignmentItem,
  type AssignmentView,
  presentAssignment,
  presentProgress,
} from "@/lib/learner-assignment-view";
import { AssignmentStatusBadge } from "./AssignmentStatusBadge";
import type { AssignedLearningState } from "./useAssignedLearning";

const HEADING_ID = "assigned-learning-heading";

const PRIMARY_CTA = "bg-brand text-white group-hover:bg-brand-dark border border-transparent";
const SECONDARY_CTA = "bg-white text-text-primary border border-border group-hover:bg-surface-2";

function AssignmentCardSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-1 p-4 animate-pulse sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 flex-1 space-y-2">
        <div className="h-4 w-2/3 rounded bg-surface-3" />
        <div className="h-3 w-1/2 rounded bg-surface-3" />
        <div className="h-5 w-24 rounded-full bg-surface-3" />
      </div>
      <div className="h-11 w-full rounded-md bg-surface-3 sm:h-9 sm:w-32" />
    </div>
  );
}

function AssignmentCard({
  item,
  view,
  percent,
}: {
  item: AssignmentItem;
  view: AssignmentView;
  percent: number | undefined;
}) {
  const progress = presentProgress(view.status, percent);
  const { reason } = view;

  return (
    <Link
      href={view.href}
      className="group block rounded-lg border border-border bg-surface-1 p-4 shadow-sm transition-colors hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="wrap-break-word text-sm font-semibold text-text-primary">
            {item.courseTitle}
          </p>

          <p className="wrap-break-word text-xs text-text-secondary">
            {reason.headline}
            {reason.detail && <span className="text-text-muted"> · {reason.detail}</span>}
          </p>

          {reason.note && (
            <p className="whitespace-pre-line wrap-break-word text-xs italic text-text-muted">
              &ldquo;{reason.note}&rdquo;
            </p>
          )}

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-0.5">
            <AssignmentStatusBadge status={view.status} label={view.statusLabel} />
            {view.due && (
              <span className="text-xs text-text-muted">
                Due <time dateTime={view.due.iso}>{view.due.label}</time>
              </span>
            )}
          </div>

          {progress && (
            <div className="space-y-1 pt-1">
              <div className="flex items-center gap-2">
                <div
                  role="progressbar"
                  aria-label={`Progress in ${item.courseTitle}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progress.percent}
                  className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3"
                >
                  <div
                    className="h-full rounded-full bg-brand transition-all"
                    style={{ width: `${progress.percent}%` }}
                  />
                </div>
                <span className="shrink-0 text-xs text-text-muted">
                  {progress.percent}% complete
                </span>
              </div>
              {progress.caveat && <p className="text-xs text-text-muted">{progress.caveat}</p>}
            </div>
          )}
        </div>

        <span
          className={`inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-md px-4 text-sm font-medium transition-colors sm:min-h-9 ${
            view.status === "COMPLETED" ? SECONDARY_CTA : PRIMARY_CTA
          }`}
        >
          {view.ctaLabel}
          <ArrowRight size={14} aria-hidden="true" />
        </span>
      </div>
    </Link>
  );
}

interface AssignedLearningListProps {
  state: AssignedLearningState;
  /** Percent complete per course slug, as the rest of the dashboard already computed it. */
  progressBySlug: ReadonlyMap<string, number>;
  onRetry: () => void;
}

/**
 * Pure presentation of the three states of the Assigned learning section. The
 * items are rendered in exactly the order the API returned them: the ordering
 * rule lives in one place, on the server.
 */
export function AssignedLearningList({
  state,
  progressBySlug,
  onRetry,
}: AssignedLearningListProps) {
  return (
    <section aria-labelledby={HEADING_ID} className="space-y-3">
      <h2 id={HEADING_ID} className="text-sm font-semibold text-text-primary">
        Assigned learning
      </h2>

      {state.kind === "loading" && (
        // biome-ignore lint/a11y/useSemanticElements: <output> only allows phrasing content and this wraps block-level skeleton cards
        <div role="status" aria-live="polite" aria-busy="true" className="space-y-3">
          <span className="sr-only">Loading your assigned learning</span>
          <AssignmentCardSkeleton />
          <AssignmentCardSkeleton />
        </div>
      )}

      {state.kind === "error" && (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-lg border border-border bg-surface-1 p-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div>
            <p className="text-sm font-semibold text-text-primary">
              We couldn&apos;t load your assigned learning
            </p>
            <p className="mt-0.5 text-xs text-text-muted">
              The rest of your dashboard is unaffected. Please try again.
            </p>
          </div>
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-md border border-border bg-white px-4 text-sm font-medium text-text-primary transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand sm:min-h-9"
          >
            Try again
          </button>
        </div>
      )}

      {state.kind === "ready" && state.assignments.length === 0 && (
        <div className="rounded-lg border border-border bg-surface-1">
          <EmptyState
            compact
            title="No assigned learning yet"
            description="Explore courses from the catalogue when you're ready."
            ctaLabel="Explore courses"
            ctaHref="/courses"
          />
        </div>
      )}

      {state.kind === "ready" && state.assignments.length > 0 && (
        <ul className="space-y-3">
          {state.assignments.map((item) => (
            <li key={item.id}>
              <AssignmentCard
                item={item}
                view={presentAssignment(item)}
                percent={progressBySlug.get(item.courseSlug)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
