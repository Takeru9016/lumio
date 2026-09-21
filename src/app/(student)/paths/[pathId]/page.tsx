import { LearnerPathDetailClient } from "@/components/learner-path/LearnerPathDetailClient";

/** One published learning path. The id is only the URL's; the API decides whether it may be seen. */
export default async function LearningPathPage({
  params,
}: {
  params: Promise<{ pathId: string }>;
}) {
  const { pathId } = await params;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <LearnerPathDetailClient pathId={pathId} />
    </div>
  );
}
