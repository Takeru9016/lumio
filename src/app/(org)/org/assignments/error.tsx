"use client";

export default function OrgAssignmentsError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div
        role="alert"
        className="flex flex-col items-center gap-3 rounded-lg border border-border bg-surface-1 px-6 py-12 text-center"
      >
        <h1 className="text-base font-semibold text-text-primary">
          Couldn&apos;t load assignments
        </h1>
        <p className="max-w-xs text-sm text-text-muted">
          Something went wrong while loading your organisation&apos;s assignments. Try again in a
          moment.
        </p>
        <button
          type="button"
          onClick={reset}
          className="min-h-11 rounded-md bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
