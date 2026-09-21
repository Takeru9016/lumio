import { ArrowRight } from "lucide-react";
import Link from "next/link";

import type { PathCardView } from "@/lib/learner-path-view";
import { PathProgress } from "./PathProgress";

/** One published path. The whole card is the link, like the other learner cards. */
export function LearnerPathCard({ view }: { view: PathCardView }) {
  return (
    <Link
      href={view.href}
      className="group flex h-full flex-col gap-3 rounded-lg border border-border bg-surface-1 p-4 shadow-sm transition-colors hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
    >
      <div className="min-w-0 flex-1 space-y-1.5">
        <h2 className="wrap-break-word text-sm font-semibold text-text-primary">{view.title}</h2>
        {view.description && (
          <p className="line-clamp-3 wrap-break-word text-xs text-text-secondary">
            {view.description}
          </p>
        )}
        <p className="text-xs text-text-muted">{view.courseCountLabel}</p>
      </div>

      <PathProgress progress={view.progress} label={view.title} />

      <span className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md bg-brand px-4 text-sm font-medium text-white transition-colors group-hover:bg-brand-dark sm:min-h-9">
        {view.ctaLabel}
        <ArrowRight size={14} aria-hidden="true" />
      </span>
    </Link>
  );
}
