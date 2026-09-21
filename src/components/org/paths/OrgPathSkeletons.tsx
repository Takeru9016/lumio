const ROWS = [0, 1, 2, 3];

export function OrgPathsSkeleton() {
  return (
    // biome-ignore lint/a11y/useSemanticElements: <output> only allows phrasing content and this wraps block-level skeleton rows
    <div role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Loading learning paths</span>
      <div className="animate-pulse space-y-3" aria-hidden="true">
        {ROWS.map((n) => (
          <div
            key={n}
            className="flex flex-col gap-3 rounded-lg border border-border bg-surface-1 p-4 md:flex-row md:justify-between"
          >
            <div className="min-w-0 flex-1 space-y-2">
              <div className="h-4 w-1/3 rounded bg-surface-3" />
              <div className="h-3 w-2/3 rounded bg-surface-3" />
              <div className="h-3 w-1/4 rounded bg-surface-3" />
            </div>
            <div className="h-6 w-24 rounded-full bg-surface-3" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function PathEditorSkeleton() {
  return (
    // biome-ignore lint/a11y/useSemanticElements: <output> only allows phrasing content and this wraps block-level skeleton content
    <div role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Loading learning path</span>
      <div className="animate-pulse space-y-6" aria-hidden="true">
        <div className="h-3 w-40 rounded bg-surface-3" />
        <div className="space-y-3 rounded-lg border border-border bg-surface-1 p-4">
          <div className="h-6 w-1/2 rounded bg-surface-3" />
          <div className="h-4 w-2/3 rounded bg-surface-3" />
          <div className="flex gap-2">
            <div className="h-11 w-28 rounded-md bg-surface-3" />
            <div className="h-11 w-28 rounded-md bg-surface-3" />
          </div>
        </div>
        <div className="space-y-3">
          {ROWS.slice(0, 3).map((n) => (
            <div key={n} className="h-16 rounded-lg border border-border bg-surface-1" />
          ))}
        </div>
      </div>
    </div>
  );
}
