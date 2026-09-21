"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";

import { LoadErrorPanel } from "@/components/learning-path/LoadErrorPanel";
import { PathNotFoundPanel } from "@/components/learning-path/PathNotFoundPanel";
import { useLoad } from "@/components/learning-path/useLoad";
import { loadLearnerPath } from "@/lib/learner-path-client";
import { PATHS_PATH, presentPathCourses, presentProgress } from "@/lib/learner-path-view";
import { LearnerCourseRow } from "./LearnerCourseRow";
import { LearnerPathDetailSkeleton } from "./LearnerPathSkeletons";
import { PathProgress } from "./PathProgress";

/**
 * One published path, from one request to `/api/paths/[pathId]`: its title, the
 * server's progress and the whole course sequence. Nothing is fetched per course.
 * A path that is missing, unpublished or someone else's is the same "not found".
 */
export function LearnerPathDetailClient({ pathId }: { pathId: string }) {
  const { state, reload } = useLoad((signal) => loadLearnerPath(pathId, fetch, signal), pathId);

  if (state.kind === "loading") return <LearnerPathDetailSkeleton />;

  if (state.kind === "not_found") {
    return (
      <PathNotFoundPanel
        title="Learning path not found"
        description="This path doesn't exist, or it isn't available to you."
        backHref={PATHS_PATH}
        backLabel="Back to learning paths"
      />
    );
  }

  if (state.kind === "error") {
    return (
      <LoadErrorPanel
        title="Couldn't load this learning path"
        message={state.message}
        onRetry={() => void reload()}
      />
    );
  }

  const path = state.data;
  const progress = presentProgress(path.progress);
  const rows = presentPathCourses(path);

  return (
    <div className="space-y-6">
      <nav aria-label="Breadcrumb">
        <ol className="flex flex-wrap items-center gap-1 text-xs text-text-muted">
          <li>
            <Link
              href={PATHS_PATH}
              className="inline-flex min-h-11 items-center rounded-sm hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand md:min-h-0"
            >
              Learning Paths
            </Link>
          </li>
          <li aria-hidden="true">
            <ChevronRight size={12} />
          </li>
          <li aria-current="page" className="min-w-0 wrap-break-word text-text-secondary">
            {path.title}
          </li>
        </ol>
      </nav>

      <div className="space-y-1">
        <h1 className="wrap-break-word font-heading text-xl font-semibold text-text-primary">
          {path.title}
        </h1>
        {path.description && (
          <p className="max-w-2xl whitespace-pre-line wrap-break-word text-sm text-text-muted">
            {path.description}
          </p>
        )}
      </div>

      <section
        aria-label="Your progress"
        className="rounded-lg border border-border bg-surface-1 p-4 shadow-sm"
      >
        <PathProgress progress={progress} label={path.title} />
      </section>

      <section aria-labelledby="path-courses-heading" className="space-y-3">
        <h2 id="path-courses-heading" className="text-sm font-semibold text-text-primary">
          Courses in this path
        </h2>
        {rows.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border bg-surface-1 px-4 py-8 text-center text-sm text-text-muted">
            This path has no courses yet.
          </p>
        ) : (
          <ol className="space-y-3">
            {rows.map((row) => (
              <LearnerCourseRow key={row.key} view={row} />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
