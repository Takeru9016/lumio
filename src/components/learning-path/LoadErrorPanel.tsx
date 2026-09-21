interface LoadErrorPanelProps {
  title: string;
  message: string;
  onRetry: () => void;
}

/** A read that failed: what happened in words, and a way to try again. Never partial or stale data. */
export function LoadErrorPanel({ title, message, onRetry }: LoadErrorPanelProps) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-3 rounded-lg border border-border bg-surface-1 px-6 py-12 text-center"
    >
      <h2 className="text-base font-semibold text-text-primary">{title}</h2>
      <p className="max-w-sm text-sm text-text-muted">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="min-h-11 rounded-md bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      >
        Try again
      </button>
    </div>
  );
}
