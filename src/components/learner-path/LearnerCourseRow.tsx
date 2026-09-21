import { ArrowRight, CircleCheck, CircleDot, Lock, type LucideIcon } from "lucide-react";
import Link from "next/link";

import type { LearnerCourseAvailability } from "@/lib/domain/learner-path/availability";
import type { CourseRowView } from "@/lib/learner-path-view";

// Colour is never the only signal: each state has its own icon and its own word.
const STATE_STYLES: Record<
  LearnerCourseAvailability,
  { icon: LucideIcon; badge: string; marker: string }
> = {
  COMPLETED: {
    icon: CircleCheck,
    badge: "bg-success-bg text-success",
    marker: "border-success bg-success-bg text-success",
  },
  AVAILABLE: {
    icon: CircleDot,
    badge: "bg-brand-light text-brand",
    marker: "border-brand bg-brand-light text-brand",
  },
  UNAVAILABLE: {
    icon: Lock,
    badge: "bg-surface-3 text-text-muted",
    marker: "border-border bg-surface-3 text-text-disabled",
  },
};

/**
 * One course of the sequence. A course the server redacted is drawn from its
 * position and prerequisite state alone: it has no title to show and no link to
 * follow, and the row does not pretend otherwise.
 */
export function LearnerCourseRow({ view }: { view: CourseRowView }) {
  const { icon: Icon, badge, marker } = STATE_STYLES[view.availability];
  const locked = view.availability === "UNAVAILABLE";

  return (
    <li
      data-availability={view.availability}
      className={`flex gap-3 rounded-lg border border-border p-4 ${
        locked ? "bg-surface-2" : "bg-surface-1 shadow-sm"
      }`}
    >
      <span
        aria-hidden="true"
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${marker}`}
      >
        {view.positionLabel}
      </span>

      <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          <h3
            className={`wrap-break-word text-sm font-semibold ${
              locked ? "text-text-muted" : "text-text-primary"
            }`}
          >
            <span className="sr-only">{`Step ${view.key}: `}</span>
            {view.title ?? view.subject}
          </h3>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${badge}`}
            >
              <Icon size={12} aria-hidden="true" />
              {view.availabilityLabel}
            </span>
            {view.prerequisiteLabel && (
              <span className="text-xs text-text-muted">{view.prerequisiteLabel}</span>
            )}
          </div>
        </div>

        {view.href && view.ctaLabel && (
          <Link
            href={view.href}
            aria-label={`${view.ctaLabel}: ${view.subject}`}
            className={`inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-md px-4 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand sm:min-h-9 ${
              view.availability === "COMPLETED"
                ? "border border-border bg-white text-text-primary hover:bg-surface-2"
                : "bg-brand text-white hover:bg-brand-dark"
            }`}
          >
            {view.ctaLabel}
            <ArrowRight size={14} aria-hidden="true" />
          </Link>
        )}
      </div>
    </li>
  );
}
