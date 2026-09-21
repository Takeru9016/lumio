const PLACEHOLDERS = [0, 1, 2];

export function PathCardSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-1 p-4 animate-pulse">
      <div className="space-y-2">
        <div className="h-4 w-2/3 rounded bg-surface-3" />
        <div className="h-3 w-full rounded bg-surface-3" />
        <div className="h-3 w-1/3 rounded bg-surface-3" />
      </div>
      <div className="space-y-1.5">
        <div className="h-3 w-1/2 rounded bg-surface-3" />
        <div className="h-1.5 w-full rounded-full bg-surface-3" />
      </div>
      <div className="h-11 w-full rounded-md bg-surface-3 sm:h-9" />
    </div>
  );
}

export function LearnerPathsSkeleton() {
  return (
    // biome-ignore lint/a11y/useSemanticElements: <output> only allows phrasing content and this wraps block-level skeleton cards
    <div role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Loading learning paths</span>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
        {PLACEHOLDERS.map((n) => (
          <PathCardSkeleton key={n} />
        ))}
      </div>
    </div>
  );
}

export function LearnerPathDetailSkeleton() {
  return (
    // biome-ignore lint/a11y/useSemanticElements: <output> only allows phrasing content and this wraps block-level skeleton content
    <div role="status" aria-live="polite" aria-busy="true" className="space-y-6">
      <span className="sr-only">Loading learning path</span>
      <div className="animate-pulse space-y-6" aria-hidden="true">
        <div className="h-3 w-40 rounded bg-surface-3" />
        <div className="space-y-2">
          <div className="h-6 w-2/3 rounded bg-surface-3" />
          <div className="h-4 w-full max-w-lg rounded bg-surface-3" />
        </div>
        <div className="space-y-2 rounded-lg border border-border bg-surface-1 p-4">
          <div className="h-3 w-1/3 rounded bg-surface-3" />
          <div className="h-1.5 w-full rounded-full bg-surface-3" />
        </div>
        <div className="space-y-3">
          {PLACEHOLDERS.map((n) => (
            <div key={n} className="flex gap-3 rounded-lg border border-border bg-surface-1 p-4">
              <div className="h-8 w-8 shrink-0 rounded-full bg-surface-3" />
              <div className="flex-1 space-y-2">
                <div className="h-4 w-1/2 rounded bg-surface-3" />
                <div className="h-3 w-1/3 rounded bg-surface-3" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
