import { CircleCheck, CircleDashed, CircleDot, Clock, type LucideIcon } from "lucide-react";

import type { AssignmentView } from "@/lib/learner-assignment-view";

// Colour is never the only signal: every status has its own icon and its own
// word. Tokens follow the existing status badges (overdue = danger,
// completed = success, an open item = brand / info).
const STATUS_STYLES: Record<AssignmentView["status"], { icon: LucideIcon; className: string }> = {
  ASSIGNED: { icon: CircleDashed, className: "bg-brand-light text-brand" },
  STARTED: { icon: CircleDot, className: "bg-info-bg text-info" },
  OVERDUE: { icon: Clock, className: "bg-danger-bg text-danger" },
  COMPLETED: { icon: CircleCheck, className: "bg-success-bg text-success" },
};

interface AssignmentStatusBadgeProps {
  status: AssignmentView["status"];
  label: string;
}

export function AssignmentStatusBadge({ status, label }: AssignmentStatusBadgeProps) {
  const { icon: Icon, className } = STATUS_STYLES[status];
  return (
    <span
      data-status={status}
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${className}`}
    >
      <Icon size={12} aria-hidden="true" />
      {label}
    </span>
  );
}
