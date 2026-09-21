import { LearnerPathDetailSkeleton } from "@/components/learner-path/LearnerPathSkeletons";

export default function LearningPathLoading() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <LearnerPathDetailSkeleton />
    </div>
  );
}
