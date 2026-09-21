import { AssignmentStatusBadge } from "@/components/learning-assignment/AssignmentStatusBadge";
import type { AdminRowView } from "@/lib/admin-assignment-view";

interface AssignmentListProps {
  rows: AdminRowView[];
  onCancel: (row: AdminRowView) => void;
}

/**
 * One card per assignment. It is a list of stacked cards at every width (a wide
 * table would be unusable on a phone), and each card lays out in two columns
 * from `md` up. Status is a word and an icon, never colour alone.
 */
export function AssignmentList({ rows, onCancel }: AssignmentListProps) {
  return (
    <ul className="space-y-3">
      {rows.map((row) => (
        <li key={row.id} className="rounded-lg border border-border bg-surface-1 p-4 shadow-sm">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0 flex-1 space-y-1.5">
              <div>
                <p className="wrap-break-word text-sm font-semibold text-text-primary">
                  {row.learnerName}
                </p>
                {row.learnerName !== row.learnerEmail && (
                  <p className="wrap-break-word text-xs text-text-muted">{row.learnerEmail}</p>
                )}
              </div>
              <p className="wrap-break-word text-sm text-text-primary">{row.courseTitle}</p>
              <p className="wrap-break-word text-xs text-text-secondary">
                <span className="mr-1.5 inline-flex rounded-full bg-surface-3 px-2 py-0.5 text-[11px] font-medium text-text-secondary">
                  {row.sourceLabel}
                </span>
                {row.reason.headline}
              </p>
              {row.reason.note && (
                <p className="whitespace-pre-line wrap-break-word text-xs italic text-text-muted">
                  &ldquo;{row.reason.note}&rdquo;
                </p>
              )}
              {row.cancellation && <p className="text-xs text-text-muted">{row.cancellation}</p>}
              {row.history && <p className="text-xs text-text-muted">{row.history}</p>}
            </div>

            <div className="flex flex-col items-start gap-2 md:items-end">
              <AssignmentStatusBadge status={row.status} label={row.statusLabel} />
              <div className="space-y-0.5 text-xs text-text-muted md:text-right">
                {row.due && (
                  <p>
                    Due <time dateTime={row.due.iso}>{row.due.label}</time>
                  </p>
                )}
                <p>
                  Assigned <time dateTime={row.created.iso}>{row.created.label}</time>
                </p>
              </div>
              {row.canCancel && (
                <button
                  type="button"
                  onClick={() => onCancel(row)}
                  aria-label={`Cancel assignment: ${row.subject}`}
                  className="min-h-11 rounded-md border border-border bg-white px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand md:min-h-8"
                >
                  Cancel assignment
                </button>
              )}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
