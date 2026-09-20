"use client";

import { useCallback, useEffect, useState } from "react";

import { type AssignmentItem, loadAssignedLearning } from "@/lib/learner-assignment-view";

export type AssignedLearningState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; assignments: AssignmentItem[] };

export function useAssignedLearning(): { state: AssignedLearningState; retry: () => void } {
  const [state, setState] = useState<AssignedLearningState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  // `attempt` is the retry trigger: bumping it re-runs the request.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is intentionally a dependency, it is read only to re-run this effect
  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });

    loadAssignedLearning(fetch, controller.signal).then((result) => {
      if (!controller.signal.aborted) setState(result);
    });

    return () => controller.abort();
  }, [attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return { state, retry };
}
