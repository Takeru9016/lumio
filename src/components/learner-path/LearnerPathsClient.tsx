"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { LoadErrorPanel } from "@/components/learning-path/LoadErrorPanel";
import { useLoad } from "@/components/learning-path/useLoad";
import { EmptyState } from "@/components/shared/EmptyState";
import { loadLearnerPaths } from "@/lib/learner-path-client";
import { PATHS_PATH, presentPathCard } from "@/lib/learner-path-view";
import { LearnerPathCard } from "./LearnerPathCard";
import { LearnerPathsSkeleton } from "./LearnerPathSkeletons";

const LINK_BUTTON =
  "inline-flex min-h-11 items-center justify-center rounded-md border border-border bg-white px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";

/**
 * The learner's published paths: one request to `/api/paths` for the page named in
 * the URL. The cursor is in the URL, so a page can be linked to, refreshed and
 * gone back to, and the list never holds a page it did not just read.
 */
export function LearnerPathsClient() {
  const cursor = useSearchParams().get("cursor");
  const { state, reload } = useLoad(
    (signal) => loadLearnerPaths(cursor, fetch, signal),
    cursor ?? ""
  );

  if (state.kind === "loading") return <LearnerPathsSkeleton />;

  if (state.kind === "error") {
    return (
      <LoadErrorPanel
        title="Couldn't load learning paths"
        message={state.message}
        onRetry={() => void reload()}
      />
    );
  }

  if (state.kind === "not_found") {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border bg-surface-1 px-6 py-12 text-center">
        <h2 className="text-base font-semibold text-text-primary">
          That page isn&apos;t available
        </h2>
        <p className="max-w-sm text-sm text-text-muted">
          The link may be out of date. Start again from the first page.
        </p>
        <Link href={PATHS_PATH} className={LINK_BUTTON}>
          Back to learning paths
        </Link>
      </div>
    );
  }

  const { paths, nextCursor } = state.data;

  if (paths.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface-1">
        {cursor ? (
          <div className="flex flex-col items-center px-4 py-10 text-center">
            <h2 className="mb-1 text-base font-semibold text-text-primary">No more paths</h2>
            <p className="mb-4 max-w-xs text-sm text-text-muted">
              There is nothing after the last page you were on.
            </p>
            <Link href={PATHS_PATH} className={LINK_BUTTON}>
              Back to the first page
            </Link>
          </div>
        ) : (
          <EmptyState
            title="No learning paths yet"
            description="When your organisation publishes a learning path, it will appear here. Your courses are still available."
            ctaLabel="Go to my courses"
            ctaHref="/courses"
          />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {paths.map((path) => (
          <li key={path.id}>
            <LearnerPathCard view={presentPathCard(path)} />
          </li>
        ))}
      </ul>

      {(nextCursor || cursor) && (
        <nav
          aria-label="Learning path pages"
          className="flex flex-wrap items-center justify-end gap-2"
        >
          {cursor && (
            <Link href={PATHS_PATH} className={LINK_BUTTON}>
              First page
            </Link>
          )}
          {nextCursor && (
            <Link
              href={`${PATHS_PATH}?cursor=${encodeURIComponent(nextCursor)}`}
              className={LINK_BUTTON}
            >
              Older paths
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}
