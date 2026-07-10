import { AiBadge } from "@/components/shared/AiBadge";
import { PLAN_LIMITS } from "@/constants/plans";
import type { Plan } from "@/types";

interface BillingSettingsProps {
  plan: Plan;
  aiCallsUsed: number;
  subscriptionStatus: "ACTIVE" | "CANCELLED" | "PAST_DUE" | "PAUSED" | null;
}

function formatQuota(limit: number): string {
  return limit === Number.POSITIVE_INFINITY ? "Unlimited" : String(limit);
}

// Read-only by design — plan changes belong to the org admin, not the student. This
// component only ever renders from (student)/settings, which the layout already
// hard-gates to role === "STUDENT".
export function BillingSettings({ plan, aiCallsUsed, subscriptionStatus }: BillingSettingsProps) {
  const limits = PLAN_LIMITS[plan];
  const aiRemaining =
    limits.aiCallsPerMonth === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : Math.max(0, limits.aiCallsPerMonth - aiCallsUsed);

  return (
    <div className="space-y-4">
      <div className="bg-surface-1 border border-border rounded-lg p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs text-text-muted">Current plan</p>
            <p className="text-lg font-bold text-text-primary capitalize">{plan.toLowerCase()}</p>
          </div>
          {subscriptionStatus === "PAST_DUE" && (
            <span className="text-[11px] font-semibold text-danger bg-danger-bg rounded-full px-2 py-0.5">
              Past due
            </span>
          )}
          {subscriptionStatus === "CANCELLED" && (
            <span className="text-[11px] font-semibold text-text-muted bg-surface-3 rounded-full px-2 py-0.5">
              Cancels at period end
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 pt-1 border-t border-border">
          <AiBadge label="AI quota" />
          <span className="text-sm text-text-primary font-medium">
            {formatQuota(aiRemaining)}{" "}
            <span className="text-text-muted font-normal">
              of {formatQuota(limits.aiCallsPerMonth)} calls left this month
            </span>
          </span>
        </div>
      </div>

      <div className="bg-surface-1 border border-border rounded-lg p-5">
        <p className="text-sm font-semibold text-text-primary mb-3">What's included</p>
        <ul className="space-y-2 text-sm text-text-secondary">
          <li>{formatQuota(limits.aiCallsPerMonth)} AI calls per month</li>
          <li>{formatQuota(limits.maxCourses)} courses available to your organization</li>
        </ul>
        <p className="mt-4 text-xs text-text-muted">
          Plan changes are managed by your organization admin.
        </p>
      </div>
    </div>
  );
}
