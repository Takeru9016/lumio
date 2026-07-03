export default function DashboardLoading() {
  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6 animate-pulse">
      <div className="h-6 w-56 bg-surface-3 rounded" />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder list, no data, never reordered
          <div key={i} className="bg-surface-1 border border-border rounded-lg p-4">
            <div className="h-3 w-24 bg-surface-3 rounded mb-3" />
            <div className="h-7 w-14 bg-surface-3 rounded" />
          </div>
        ))}
      </div>

      <div className="space-y-3">
        <div className="h-4 w-36 bg-surface-3 rounded" />
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder list, no data, never reordered
            key={i}
            className="flex items-center gap-4 bg-surface-1 border border-border rounded-lg p-4"
          >
            <div className="h-12 w-20 shrink-0 rounded-md bg-surface-3" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="h-3.5 w-2/3 bg-surface-3 rounded" />
              <div className="h-1.5 w-full bg-surface-3 rounded-full" />
            </div>
          </div>
        ))}
      </div>

      <div className="h-16 bg-surface-3 rounded-lg" />
    </div>
  );
}
