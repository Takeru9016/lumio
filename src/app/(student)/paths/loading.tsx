import { LearnerPathsSkeleton } from "@/components/learner-path/LearnerPathSkeletons";

export default function LearningPathsLoading() {
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-6">
      <div className="animate-pulse space-y-2">
        <div className="h-6 w-40 rounded bg-surface-3" />
        <div className="h-4 w-2/3 rounded bg-surface-3" />
      </div>
      <LearnerPathsSkeleton />
    </div>
  );
}
