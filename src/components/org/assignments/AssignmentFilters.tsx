import Link from "next/link";
import type { AssignmentSource } from "@/generated/prisma/enums";
import { filterHref, SOURCE_FILTERS, STATUS_FILTERS } from "@/lib/admin-assignment-view";
import type { AssignmentStatus } from "@/lib/domain/learning-assignment/status";

interface AssignmentFiltersProps {
  source: AssignmentSource | null;
  status: AssignmentStatus | null;
}

const PILL =
  "inline-flex min-h-11 items-center rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand md:min-h-8";

function pillClass(active: boolean) {
  return `${PILL} ${
    active
      ? "border-brand bg-brand-light text-brand"
      : "border-border bg-white text-text-secondary hover:bg-surface-2"
  }`;
}

/** Plain links: the filter is in the URL, so it is shareable, back-button friendly and works without script. */
export function AssignmentFilters({ source, status }: AssignmentFiltersProps) {
  return (
    <nav aria-label="Filter assignments" className="space-y-2">
      <ul className="flex flex-wrap gap-2" aria-label="Source">
        {SOURCE_FILTERS.map((f) => (
          <li key={f.label}>
            <Link
              href={filterHref({ source: f.value, status })}
              aria-current={f.value === source ? "true" : undefined}
              className={pillClass(f.value === source)}
            >
              {f.label}
            </Link>
          </li>
        ))}
      </ul>
      <ul className="flex flex-wrap gap-2" aria-label="Status">
        {STATUS_FILTERS.map((f) => (
          <li key={f.label}>
            <Link
              href={filterHref({ source, status: f.value })}
              aria-current={f.value === status ? "true" : undefined}
              className={pillClass(f.value === status)}
            >
              {f.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
