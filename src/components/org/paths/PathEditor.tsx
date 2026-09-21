"use client";

import { toast } from "gooey-toast";
import { ChevronRight, Plus } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";

import { LoadErrorPanel } from "@/components/learning-path/LoadErrorPanel";
import { PathNotFoundPanel } from "@/components/learning-path/PathNotFoundPanel";
import { useLoad } from "@/components/learning-path/useLoad";
import {
  type AdminFailure,
  type AdminResult,
  addCourse,
  archivePath,
  loadAdminPath,
  type PathCourseChoice,
  publishPath,
  removeCourse,
  reorderCourses,
  updatePath,
} from "@/lib/admin-path-client";
import {
  type AdminCourseView,
  ORG_PATHS_PATH,
  pathActions,
  placeFailure,
  planAfterChange,
  pluralCourses,
  presentAdminCourse,
} from "@/lib/admin-path-view";
import { formatDueDate } from "@/lib/learner-assignment-view";
import { AddCourseDialog } from "./AddCourseDialog";
import { type ConfirmCopy, ConfirmPathDialog } from "./ConfirmPathDialog";
import { FailureNotice } from "./FailureNotice";
import { PathEditorSkeleton } from "./OrgPathSkeletons";
import { PathCourseList } from "./PathCourseList";
import { PathMetadataForm } from "./PathMetadataForm";
import { PathStatusBadge } from "./PathStatusBadge";
import { PublishPathDialog } from "./PublishPathDialog";

const BUTTON =
  "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY = `${BUTTON} bg-brand text-white hover:bg-brand-dark`;
const SECONDARY = `${BUTTON} border border-border bg-white text-text-primary hover:bg-surface-2`;

const ANOTHER_CHANGE: AdminFailure = {
  message: "Another change is still being saved. Try again in a moment.",
  code: null,
  status: null,
  problems: [],
  refresh: false,
};

/**
 * Puts focus back where the person was when they opened a dialog. If that element
 * has since gone (a removed course loses its button), it goes to the fallback, so
 * keyboard focus is never dropped on the page.
 */
function restoreFocus(opener: HTMLElement | null, fallback: HTMLElement | null, event: Event) {
  event.preventDefault();
  (opener?.isConnected ? opener : fallback)?.focus();
}

interface PathEditorProps {
  pathId: string;
  /** The organisation's courses to pick from; read by the page, since no API lists them. */
  courseChoices: readonly PathCourseChoice[];
}

/**
 * One learning path for its administrator: one request to `/api/org/paths/[id]`
 * gives the whole editor. Every change goes to its own endpoint and is followed by
 * a fresh read, so what is shown is what the server holds and never a guess. What
 * a status offers only decides which controls are drawn; the server refuses
 * anything the lifecycle does not allow, and its answer is shown as it comes.
 */
export function PathEditor({ pathId, courseChoices }: PathEditorProps) {
  const { state, reload, refresh } = useLoad(
    (signal) => loadAdminPath(pathId, fetch, signal),
    pathId
  );

  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [orderEpoch, setOrderEpoch] = useState(0);
  // A refusal that also means the screen was out of date. The form or list that asked
  // may be gone once the path is read again (an archived path has no form; a changed
  // order rebuilds the list), so the message is kept here, where it cannot be lost.
  const [notice, setNotice] = useState<AdminFailure | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<AdminCourseView | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);

  const addButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  const remember = () => {
    opener.current = document.activeElement as HTMLElement | null;
  };
  const focusBack = (event: Event) =>
    restoreFocus(opener.current, addButton.current ?? heading.current, event);

  /**
   * Runs one change. The path is read again afterwards whether it went through or
   * the server said what is on screen is out of date; a refusal is handed back to
   * whoever asked, to be shown where they are looking.
   */
  async function mutate(
    change: () => Promise<AdminResult<unknown>>,
    success: string
  ): Promise<AdminFailure | null> {
    if (inFlight.current) return ANOTHER_CHANGE;
    inFlight.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const plan = planAfterChange(await change(), success);
      if (plan.resetOrder) setOrderEpoch((n) => n + 1);
      if (plan.toast) toast.success({ title: plan.toast });
      if (plan.refresh) await refresh();
      return plan.failure;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  /** A refusal that moved the server's state is shown at page level; any other is shown where it was asked. */
  const surface = (refusal: AdminFailure | null): AdminFailure | null => {
    const { page, local } = placeFailure(refusal);
    if (page) setNotice(page);
    return local;
  };

  if (state.kind === "loading") return <PathEditorSkeleton />;

  if (state.kind === "not_found") {
    return (
      <PathNotFoundPanel
        title="Learning path not found"
        description="This path doesn't exist, or it isn't available to you."
        backHref={ORG_PATHS_PATH}
        backLabel="Back to learning paths"
      />
    );
  }

  if (state.kind === "error") {
    return (
      <LoadErrorPanel
        title="Couldn't load this learning path"
        message={state.failure.message}
        onRetry={() => void reload()}
      />
    );
  }

  const path = state.data;
  const actions = pathActions(path.status);
  const courses = path.courses.map(presentAdminCourse);
  const memberIds = new Set(courses.map((c) => c.courseId));
  const created = formatDueDate(path.createdAt);
  const published = formatDueDate(path.publishedAt);

  const archiveCopy: ConfirmCopy = {
    title: "Archive this learning path?",
    description:
      path.status === "PUBLISHED"
        ? "Learners will no longer see this path. Its courses and their order are kept, and you can republish it later."
        : "This path will be archived. Its courses and their order are kept, and you can republish it later.",
    subject: path.title,
    confirmLabel: "Archive",
    pendingLabel: "Archiving…",
    cancelLabel: "Keep path",
  };

  const removeCopy: ConfirmCopy | null = removeTarget
    ? {
        title: "Remove course?",
        description: `This will remove "${removeTarget.title}" from this path. The course itself is not deleted.`,
        confirmLabel: "Remove",
        pendingLabel: "Removing…",
        cancelLabel: "Keep course",
      }
    : null;

  return (
    <div className="space-y-6">
      <nav aria-label="Breadcrumb">
        <ol className="flex flex-wrap items-center gap-1 text-xs text-text-muted">
          <li>
            <Link
              href={ORG_PATHS_PATH}
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

      <header className="space-y-4 rounded-lg border border-border bg-surface-1 p-4 shadow-sm">
        <div className="flex flex-col items-start gap-2 sm:flex-row sm:justify-between">
          <h1
            ref={heading}
            tabIndex={-1}
            className="min-w-0 wrap-break-word font-heading text-xl font-semibold text-text-primary focus:outline-none"
          >
            {path.title}
          </h1>
          <PathStatusBadge status={path.status} />
        </div>

        {path.description && (
          <p className="max-w-2xl whitespace-pre-line wrap-break-word text-sm text-text-muted">
            {path.description}
          </p>
        )}

        <p className="text-xs text-text-muted">
          {pluralCourses(path.courses.length)}
          {created && <> · Created {created}</>}
          {published && <> · Published {published}</>}
        </p>

        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {actions.canPublish && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                remember();
                setPublishOpen(true);
              }}
              className={PRIMARY}
            >
              Publish
            </button>
          )}
          {actions.canRepublish && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                remember();
                setPublishOpen(true);
              }}
              className={PRIMARY}
            >
              Republish
            </button>
          )}
          {actions.canArchive && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                remember();
                setArchiveOpen(true);
              }}
              className={SECONDARY}
            >
              Archive
            </button>
          )}
        </div>
      </header>

      {path.status === "ARCHIVED" && (
        <output className="block rounded-lg border border-border bg-surface-2 px-4 py-3 text-sm text-text-secondary">
          This path is archived and read-only. Learners can&apos;t see it. Republish it to make
          changes.
        </output>
      )}

      {notice && <FailureNotice failure={notice} />}

      {actions.canEdit && (
        <section aria-labelledby="path-details-heading" className="space-y-3">
          <h2 id="path-details-heading" className="text-sm font-semibold text-text-primary">
            Details
          </h2>
          <div className="rounded-lg border border-border bg-surface-1 p-4 shadow-sm">
            <PathMetadataForm
              key={`${path.title}\u0000${path.description ?? ""}`}
              initial={{ title: path.title, description: path.description ?? "" }}
              busy={busy}
              onSave={async (fields) =>
                surface(await mutate(() => updatePath(pathId, fields), "Details saved"))
              }
            />
          </div>
        </section>
      )}

      <section aria-labelledby="path-courses-heading" className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 id="path-courses-heading" className="text-sm font-semibold text-text-primary">
            Courses
          </h2>
          {actions.canManageCourses && (
            <button
              ref={addButton}
              type="button"
              disabled={busy}
              onClick={() => {
                remember();
                setAddOpen(true);
              }}
              className={SECONDARY}
            >
              <Plus size={16} aria-hidden="true" />
              Add course
            </button>
          )}
        </div>

        {courses.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border bg-surface-1 px-4 py-10 text-center text-sm text-text-muted">
            {actions.canManageCourses
              ? "No courses yet. Add courses to build the path."
              : "This path has no courses."}
          </p>
        ) : (
          <PathCourseList
            key={`${courses.map((c) => c.courseId).join(",")}|${orderEpoch}`}
            courses={courses}
            editable={actions.canManageCourses}
            busy={busy}
            onRemove={(course) => {
              remember();
              setRemoveTarget(course);
            }}
            onSaveOrder={async (ids) =>
              surface(await mutate(() => reorderCourses(pathId, ids), "Order saved"))
            }
          />
        )}
      </section>

      <AddCourseDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        choices={courseChoices}
        memberIds={memberIds}
        onAdd={(courseId) => mutate(() => addCourse(pathId, courseId), "Course added")}
        onCloseAutoFocus={focusBack}
      />

      <ConfirmPathDialog
        copy={removeCopy}
        onClose={() => setRemoveTarget(null)}
        onCloseAutoFocus={focusBack}
        onConfirm={() => {
          const target = removeTarget;
          if (!target) return Promise.resolve(null);
          return mutate(() => removeCourse(pathId, target.courseId), "Course removed");
        }}
      />

      <PublishPathDialog
        open={publishOpen}
        republish={path.status === "ARCHIVED"}
        pathTitle={path.title}
        onClose={() => setPublishOpen(false)}
        onCloseAutoFocus={focusBack}
        onConfirm={() =>
          mutate(
            () => publishPath(pathId),
            path.status === "ARCHIVED" ? "Path republished" : "Path published"
          )
        }
      />

      <ConfirmPathDialog
        copy={archiveOpen ? archiveCopy : null}
        onClose={() => setArchiveOpen(false)}
        onCloseAutoFocus={focusBack}
        onConfirm={() => mutate(() => archivePath(pathId), "Path archived")}
      />
    </div>
  );
}
