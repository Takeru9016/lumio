import { Archive, CircleCheck, type LucideIcon, PencilLine } from "lucide-react";

import type { PathStatus } from "@/lib/admin-path-client";
import { STATUS_LABELS } from "@/lib/admin-path-view";

// Colour is never the only signal: each status has its own icon and its own word.
const STATUS_STYLES: Record<PathStatus, { icon: LucideIcon; className: string }> = {
  DRAFT: { icon: PencilLine, className: "bg-surface-3 text-text-muted" },
  PUBLISHED: { icon: CircleCheck, className: "bg-success-bg text-success" },
  ARCHIVED: { icon: Archive, className: "bg-warning-bg text-warning" },
};

export function PathStatusBadge({ status, label }: { status: PathStatus; label?: string }) {
  const { icon: Icon, className } = STATUS_STYLES[status];
  return (
    <span
      data-status={status}
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${className}`}
    >
      <Icon size={12} aria-hidden="true" />
      {label ?? STATUS_LABELS[status]}
    </span>
  );
}
