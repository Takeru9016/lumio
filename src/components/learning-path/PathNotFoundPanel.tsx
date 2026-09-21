import Link from "next/link";

interface PathNotFoundPanelProps {
  title: string;
  description: string;
  backHref: string;
  backLabel: string;
}

/** One answer for a path that is missing, someone else's, or not yours to see: it never says which. */
export function PathNotFoundPanel({
  title,
  description,
  backHref,
  backLabel,
}: PathNotFoundPanelProps) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border bg-surface-1 px-6 py-12 text-center">
      <h2 className="text-base font-semibold text-text-primary">{title}</h2>
      <p className="max-w-sm text-sm text-text-muted">{description}</p>
      <Link
        href={backHref}
        className="inline-flex min-h-11 items-center justify-center rounded-md border border-border bg-white px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      >
        {backLabel}
      </Link>
    </div>
  );
}
