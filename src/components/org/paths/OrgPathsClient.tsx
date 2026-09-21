"use client";

import { toast } from "gooey-toast";
import { ChevronRight, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useRef, useState } from "react";
import { LoadErrorPanel } from "@/components/learning-path/LoadErrorPanel";
import { useLoad } from "@/components/learning-path/useLoad";
import { EmptyState } from "@/components/shared/EmptyState";
import { loadAdminPaths } from "@/lib/admin-path-client";
import {
  adminListQuery,
  filterHref,
  ORG_PATHS_PATH,
  orgPathHref,
  presentPathRow,
  STATUS_FILTERS,
  STATUS_LABELS,
} from "@/lib/admin-path-view";
import { CreatePathDialog } from "./CreatePathDialog";
import { OrgPathsSkeleton } from "./OrgPathSkeletons";
import { PathStatusBadge } from "./PathStatusBadge";

const LINK_BUTTON =
  "inline-flex min-h-11 items-center justify-center rounded-md border border-border bg-white px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";

const PILL =
  "inline-flex min-h-11 items-center rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand md:min-h-8";

const pillClass = (active: boolean) =>
  `${PILL} ${
    active
      ? "border-brand bg-brand-light text-brand"
      : "border-border bg-white text-text-secondary hover:bg-surface-2"
  }`;

/**
 * The organisation's learning paths. The status filter and the page cursor are in
 * the URL and are sent to the API, so the server cuts every page (nothing is
 * filtered client-side from a partial page), and a page can be linked to and gone
 * back to. Creating a path opens its editor.
 */
export function OrgPathsClient() {
  const router = useRouter();
  const params = useSearchParams();
  const query = adminListQuery(params);
  const { status, cursor } = query;

  const { state, reload } = useLoad(
    (signal) => loadAdminPaths(query, fetch, signal),
    `${status ?? ""}|${cursor ?? ""}`
  );

  const [createOpen, setCreateOpen] = useState(false);
  const createButton = useRef<HTMLButtonElement>(null);

  function renderBody() {
    if (state.kind === "loading") return <OrgPathsSkeleton />;

    if (state.kind === "error") {
      return (
        <LoadErrorPanel
          title="Couldn't load learning paths"
          message={state.failure.message}
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
            The link may be out of date. Start again from the newest paths.
          </p>
          <Link href={filterHref({ status })} className={LINK_BUTTON}>
            Newest paths
          </Link>
        </div>
      );
    }

    const { paths, nextCursor } = state.data;

    if (paths.length === 0) {
      return (
        <div className="rounded-lg border border-dashed border-border bg-surface-1">
          {cursor ? (
            <div className="flex flex-col items-center px-4 py-10 text-center">
              <h2 className="mb-1 text-base font-semibold text-text-primary">No more paths</h2>
              <p className="mb-4 max-w-xs text-sm text-text-muted">
                There is nothing older than the last page you were on.
              </p>
              <Link href={filterHref({ status })} className={LINK_BUTTON}>
                Back to the newest
              </Link>
            </div>
          ) : status ? (
            <div className="flex flex-col items-center px-4 py-10 text-center">
              <h2 className="mb-1 text-base font-semibold text-text-primary">
                No {STATUS_LABELS[status].toLowerCase()} paths
              </h2>
              <p className="mb-4 max-w-xs text-sm text-text-muted">
                Try another status, or show all learning paths.
              </p>
              <Link href={ORG_PATHS_PATH} className={LINK_BUTTON}>
                Show all paths
              </Link>
            </div>
          ) : (
            <EmptyState
              title="No learning paths yet"
              description="Group courses into an ordered path, then publish it for your learners."
              ctaLabel="Create learning path"
              onCta={() => setCreateOpen(true)}
            />
          )}
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <ul className="space-y-3">
          {paths.map((path) => {
            const row = presentPathRow(path);
            return (
              <li
                key={row.id}
                className="rounded-lg border border-border bg-surface-1 p-4 shadow-sm"
              >
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <h2 className="wrap-break-word text-sm font-semibold text-text-primary">
                      <Link
                        href={row.href}
                        className="rounded-sm hover:text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                      >
                        {row.title}
                      </Link>
                    </h2>
                    {row.description && (
                      <p className="line-clamp-2 wrap-break-word text-xs text-text-secondary">
                        {row.description}
                      </p>
                    )}
                    <p className="text-xs text-text-muted">
                      {row.courseCountLabel}
                      {row.created && <> · Created {row.created}</>}
                      {row.published && <> · Published {row.published}</>}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 md:flex-col md:items-end">
                    <PathStatusBadge status={row.status} label={row.statusLabel} />
                    <Link
                      href={row.href}
                      aria-label={`Manage ${row.title}`}
                      className="inline-flex min-h-11 items-center gap-1 rounded-md border border-border bg-white px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand md:min-h-8"
                    >
                      Manage
                      <ChevronRight size={14} aria-hidden="true" />
                    </Link>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>

        {(nextCursor || cursor) && (
          <nav
            aria-label="Learning path pages"
            className="flex flex-wrap items-center justify-end gap-2"
          >
            {cursor && (
              <Link href={filterHref({ status })} className={LINK_BUTTON}>
                Newest paths
              </Link>
            )}
            {nextCursor && (
              <Link href={filterHref({ status, cursor: nextCursor })} className={LINK_BUTTON}>
                Older paths
              </Link>
            )}
          </nav>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="font-heading text-xl font-semibold text-text-primary">Learning Paths</h1>
          <p className="mt-1 text-sm text-text-muted">
            Group courses into an ordered path and publish it for your learners.
          </p>
        </div>
        <button
          ref={createButton}
          type="button"
          onClick={() => setCreateOpen(true)}
          className="inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-md bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand sm:w-auto"
        >
          <Plus size={16} aria-hidden="true" />
          Create path
        </button>
      </div>

      <nav aria-label="Filter learning paths by status">
        <ul className="flex flex-wrap gap-2">
          {STATUS_FILTERS.map((filter) => (
            <li key={filter.label}>
              <Link
                href={filterHref({ status: filter.value })}
                aria-current={filter.value === status ? "true" : undefined}
                className={pillClass(filter.value === status)}
              >
                {filter.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {renderBody()}

      <CreatePathDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          createButton.current?.focus();
        }}
        onCreated={(path) => {
          toast.success({ title: "Learning path created" });
          setCreateOpen(false);
          router.push(orgPathHref(path.id));
        }}
      />
    </div>
  );
}
