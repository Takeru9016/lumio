import Link from "next/link";

interface EmptyStateProps {
  icon?: string;
  title: string;
  description: string;
  ctaLabel?: string;
  ctaHref?: string;
  onCta?: () => void;
}

export function EmptyState({
  icon,
  title,
  description,
  ctaLabel,
  ctaHref,
  onCta,
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      {icon && <div className="text-4xl mb-3">{icon}</div>}
      <h3 className="text-base font-semibold text-text-primary mb-1">
        {title}
      </h3>
      <p className="text-sm text-text-muted mb-4 max-w-xs">{description}</p>
      {ctaLabel && ctaHref && (
        <Link
          href={ctaHref}
          className="bg-brand text-white rounded-md px-4 py-2 text-sm font-medium hover:bg-brand-dark transition-colors"
        >
          {ctaLabel}
        </Link>
      )}
      {ctaLabel && onCta && !ctaHref && (
        <button
          onClick={onCta}
          className="bg-brand text-white rounded-md px-4 py-2 text-sm font-medium hover:bg-brand-dark transition-colors"
        >
          {ctaLabel}
        </button>
      )}
    </div>
  );
}
