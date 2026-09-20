import {
  type AssignmentItem,
  presentAssignment,
  presentProgress,
} from "@/lib/learner-assignment-view";
import { AssignmentStatusBadge } from "./AssignmentStatusBadge";

const HEADING_ID = "course-assignment-context-heading";

interface CourseAssignmentContextProps {
  assignment: AssignmentItem;
  /** The course page's own progress figure, used only to explain a STARTED-at-0% case. */
  progressPercent?: number;
}

/**
 * A quiet note, not a control panel: the course stays the primary object on the
 * page. It shows why the course is assigned, when it is due and where it stands,
 * and offers no way to change any of it.
 */
export function CourseAssignmentContext({
  assignment,
  progressPercent,
}: CourseAssignmentContextProps) {
  const view = presentAssignment(assignment);
  const caveat = presentProgress(view.status, progressPercent)?.caveat ?? null;
  const { reason } = view;

  return (
    <section
      aria-labelledby={HEADING_ID}
      className="space-y-1.5 rounded-lg border border-border bg-surface-2 p-3"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h2 id={HEADING_ID} className="text-xs font-semibold text-text-primary">
          Assigned learning
        </h2>
        <AssignmentStatusBadge status={view.status} label={view.statusLabel} />
        {view.due && (
          <span className="text-xs text-text-muted">
            Due <time dateTime={view.due.iso}>{view.due.label}</time>
          </span>
        )}
      </div>

      <p className="wrap-break-word text-xs text-text-secondary">
        {reason.headline}
        {reason.detail && <span className="text-text-muted"> · {reason.detail}</span>}
      </p>

      {reason.note && (
        <p className="whitespace-pre-line wrap-break-word text-xs italic text-text-muted">
          &ldquo;{reason.note}&rdquo;
        </p>
      )}

      {caveat && <p className="text-xs text-text-muted">{caveat}</p>}
    </section>
  );
}
