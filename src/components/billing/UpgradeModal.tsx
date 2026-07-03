"use client";

import Link from "next/link";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { PLAN_LIMITS } from "@/constants/plans";
import type { Plan } from "@/types";

const PLAN_NAME: Record<Plan, string> = {
  FREE: "Free",
  STARTER: "Starter",
  PRO: "Pro",
  ENTERPRISE: "Enterprise",
};

function planBenefits(plan: Plan): string[] {
  const limits = PLAN_LIMITS[plan];
  return [
    limits.aiCallsPerMonth === Infinity
      ? "Unlimited AI tutor calls"
      : `${limits.aiCallsPerMonth} AI tutor calls / month`,
    limits.maxCourses === Infinity ? "Unlimited courses" : `Up to ${limits.maxCourses} courses`,
    limits.maxSeats === Infinity ? "Unlimited seats" : `Up to ${limits.maxSeats} seats`,
    ...(limits.hasSSO ? ["Enterprise SSO"] : []),
    ...(limits.hasCustomDomain ? ["Custom domain"] : []),
  ];
}

interface UpgradeModalProps {
  feature: string;
  requiredPlan: Plan;
  onClose: () => void;
}

export function UpgradeModal({ feature, requiredPlan, onClose }: UpgradeModalProps) {
  const planName = PLAN_NAME[requiredPlan];

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-lg text-ai" aria-hidden>
            ✦
          </span>
          <DialogTitle className="mb-0">Upgrade to continue</DialogTitle>
        </div>

        <p className="text-sm text-text-muted mb-4">
          You&apos;ve reached your {feature} limit on your current plan.
        </p>

        <div className="rounded-lg border border-border bg-surface-2 p-4 mb-5">
          <p className="text-xs font-medium text-text-muted mb-2">{planName} plan includes</p>
          <ul className="space-y-1.5">
            {planBenefits(requiredPlan).map((benefit) => (
              <li key={benefit} className="flex items-center gap-2 text-sm text-text-primary">
                <span className="text-ai" aria-hidden>
                  ✦
                </span>
                {benefit}
              </li>
            ))}
          </ul>
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="text-text-muted rounded-md px-4 py-2 text-sm font-medium hover:bg-surface-2 transition-colors"
          >
            Dismiss
          </button>
          <Link
            href="/settings?tab=plan"
            className="bg-brand text-white rounded-md px-4 py-2 text-sm font-medium hover:bg-brand-dark transition-colors"
          >
            Upgrade to {planName}
          </Link>
        </div>
      </DialogContent>
    </Dialog>
  );
}
