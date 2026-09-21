export default function OrgAssignmentsLoading() {
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-6 animate-pulse">
      <div className="space-y-2">
        <div className="h-6 w-40 rounded bg-surface-3" />
        <div className="h-4 w-2/3 rounded bg-surface-3" />
      </div>

      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder list, no data, never reordered
          <div key={i} className="h-8 w-24 rounded-full bg-surface-3" />
        ))}
      </div>

      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder list, no data, never reordered
            key={i}
            className="flex flex-col gap-3 rounded-lg border border-border bg-surface-1 p-4 md:flex-row md:justify-between"
          >
            <div className="min-w-0 flex-1 space-y-2">
              <div className="h-4 w-1/3 rounded bg-surface-3" />
              <div className="h-3 w-1/2 rounded bg-surface-3" />
              <div className="h-3 w-2/3 rounded bg-surface-3" />
            </div>
            <div className="h-6 w-24 rounded-full bg-surface-3" />
          </div>
        ))}
      </div>
    </div>
  );
}
