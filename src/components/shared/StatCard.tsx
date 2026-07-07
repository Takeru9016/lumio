import type { LucideIcon } from "lucide-react";

interface StatCardProps {
  label: string;
  value: string | number;
  icon?: LucideIcon;
}

export function StatCard({ label, value, icon: Icon }: StatCardProps) {
  return (
    <div className="rounded-lg border border-border bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-text-muted">{label}</p>
        {Icon && <Icon size={14} className="text-text-muted" />}
      </div>
      <p className="mt-2 font-heading text-2xl font-bold text-text-primary">{value}</p>
    </div>
  );
}
