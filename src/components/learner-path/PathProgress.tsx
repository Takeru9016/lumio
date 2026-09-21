import type { ProgressView } from "@/lib/learner-path-view";

interface PathProgressProps {
  progress: ProgressView;
  /** Names the bar for assistive technology, e.g. the path's title. */
  label: string;
}

/**
 * The server's progress, drawn. A measured path shows the sentence, the percentage
 * as text and a bar; a path with nothing to measure shows only its sentence, never
 * an empty bar or a 0% that the server did not send.
 */
export function PathProgress({ progress, label }: PathProgressProps) {
  if (progress.kind === "unmeasured") {
    return <p className="text-xs text-text-muted">{progress.summary}</p>;
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs text-text-secondary">{progress.summary}</p>
        <p className="text-xs font-medium text-text-primary">{progress.percent}%</p>
      </div>
      <div
        role="progressbar"
        aria-label={`Progress in ${label}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percent}
        aria-valuetext={`${progress.summary}, ${progress.percent}%`}
        className="h-1.5 rounded-full bg-surface-3"
      >
        <div
          className={`h-full rounded-full transition-all ${
            progress.percent === 100 ? "bg-success" : "bg-brand"
          }`}
          style={{ width: `${progress.percent}%` }}
        />
      </div>
    </div>
  );
}
