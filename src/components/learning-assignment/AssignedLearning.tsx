"use client";

import { AssignedLearningList } from "./AssignedLearningList";
import { useAssignedLearning } from "./useAssignedLearning";

interface AssignedLearningProps {
  progressBySlug: ReadonlyMap<string, number>;
}

/**
 * Owns the request and nothing else. It never throws into its parent: a failed
 * request becomes the section's own error state, so the rest of the dashboard
 * is unaffected.
 */
export function AssignedLearning({ progressBySlug }: AssignedLearningProps) {
  const { state, retry } = useAssignedLearning();
  return <AssignedLearningList state={state} progressBySlug={progressBySlug} onRetry={retry} />;
}
