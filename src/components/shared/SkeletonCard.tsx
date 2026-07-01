interface SkeletonCardProps {
  count?: number;
}

function CourseCardSkeleton() {
  return (
    <div className="bg-white border border-border rounded-lg overflow-hidden animate-pulse">
      <div className="h-40 bg-surface-3" />
      <div className="p-4 space-y-2">
        <div className="h-4 bg-surface-3 rounded w-3/4" />
        <div className="h-3 bg-surface-3 rounded w-1/2" />
        <div className="h-1.5 bg-surface-3 rounded-full w-full mt-3" />
      </div>
    </div>
  );
}

export function SkeletonCard({ count = 1 }: SkeletonCardProps) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {Array.from({ length: count }).map((_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder list, no data, never reordered
        <CourseCardSkeleton key={i} />
      ))}
    </div>
  );
}
