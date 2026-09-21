import { Suspense } from "react";
import { LearnerPathsSkeleton } from "@/components/learner-path/LearnerPathSkeletons";
import { LearnerPathsClient } from "@/components/learner-path/LearnerPathsClient";

/**
 * The organisation's published learning paths (Phase 29.3.4). This is not the AI
 * recommendation page at /learning-path: these are paths an administrator built
 * and published. The list is read from the learner paths API by the client
 * component; the layout above already turns away anyone who is not a learner.
 */
export default function LearningPathsPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-6">
      <div>
        <h1 className="font-heading text-xl font-semibold text-text-primary">Learning Paths</h1>
        <p className="mt-1 text-sm text-text-muted">
          Continue your learning through structured programs.
        </p>
      </div>

      <Suspense fallback={<LearnerPathsSkeleton />}>
        <LearnerPathsClient />
      </Suspense>
    </div>
  );
}
