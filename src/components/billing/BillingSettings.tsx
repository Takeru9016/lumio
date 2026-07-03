"use client";

import { toast } from "gooey-toast";
import { Check, Loader2, Sparkles } from "lucide-react";
import { useState } from "react";
import { AiBadge } from "@/components/shared/AiBadge";
import { PLAN_LIMITS } from "@/constants/plans";
import { useRazorpay } from "@/hooks/useRazorpay";
import type { Plan } from "@/types";

type PaidPlan = "STARTER" | "PRO" | "ENTERPRISE";

const PLAN_ORDER: Plan[] = ["FREE", "STARTER", "PRO", "ENTERPRISE"];

const PLAN_COPY: Record<PaidPlan, { name: string; blurb: string }> = {
  STARTER: { name: "Starter", blurb: "50 AI calls/mo · 10 courses" },
  PRO: { name: "Pro", blurb: "200 AI calls/mo · unlimited courses" },
  ENTERPRISE: { name: "Enterprise", blurb: "Unlimited AI · SSO · custom domain" },
};

interface BillingSettingsProps {
  plan: Plan;
  aiCallsUsed: number;
  subscriptionStatus: "ACTIVE" | "CANCELLED" | "PAST_DUE" | "PAUSED" | null;
  email: string;
  name: string | null;
}

function formatQuota(limit: number): string {
  return limit === Number.POSITIVE_INFINITY ? "Unlimited" : String(limit);
}

export function BillingSettings({
  plan,
  aiCallsUsed,
  subscriptionStatus,
  email,
  name,
}: BillingSettingsProps) {
  const { openCheckout } = useRazorpay();
  const [pendingPlan, setPendingPlan] = useState<PaidPlan | null>(null);

  const limits = PLAN_LIMITS[plan];
  const aiRemaining =
    limits.aiCallsPerMonth === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : Math.max(0, limits.aiCallsPerMonth - aiCallsUsed);

  const currentIndex = PLAN_ORDER.indexOf(plan);
  const upgradeOptions = PLAN_ORDER.slice(currentIndex + 1) as PaidPlan[];

  async function handleUpgrade(target: PaidPlan) {
    setPendingPlan(target);
    try {
      const res = await fetch("/api/billing/create-subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: target }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? "Couldn't start checkout");
      }

      const { subscriptionId, razorpayKeyId } = (await res.json()) as {
        subscriptionId: string;
        razorpayKeyId: string;
      };

      await openCheckout({
        key: razorpayKeyId,
        subscription_id: subscriptionId,
        name: "Lumio",
        description: `Upgrade to ${PLAN_COPY[target].name}`,
        prefill: { name: name ?? undefined, email },
        theme: { color: "#4F6EF7" },
        handler: async (response) => {
          const verifyRes = await fetch("/api/billing/verify-payment", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(response),
          });
          const { verified } = (await verifyRes.json().catch(() => ({ verified: false }))) as {
            verified: boolean;
          };

          if (verified) {
            toast.success({
              title: "Payment successful",
              description: "Your plan will update in a few moments.",
            });
          } else {
            toast.error({
              title: "Payment verification failed",
              description: "If you were charged, contact support.",
            });
          }
        },
        modal: {
          ondismiss: () => setPendingPlan(null),
        },
      });
    } catch (err) {
      toast.error({
        title: err instanceof Error ? err.message : "Couldn't start checkout",
      });
    } finally {
      setPendingPlan(null);
    }
  }

  return (
    <div className="space-y-4">
      {/* Current plan */}
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

      {/* Upgrade options */}
      {upgradeOptions.length > 0 ? (
        <div className="space-y-3">
          <p className="text-sm font-semibold text-text-primary">Upgrade your plan</p>
          {upgradeOptions.map((target) => (
            <div
              key={target}
              className="bg-surface-1 border border-border rounded-lg p-4 flex items-center justify-between gap-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-semibold text-text-primary">{PLAN_COPY[target].name}</p>
                <p className="text-xs text-text-muted">{PLAN_COPY[target].blurb}</p>
              </div>
              <button
                type="button"
                onClick={() => handleUpgrade(target)}
                disabled={pendingPlan !== null}
                className="inline-flex items-center gap-1.5 bg-[var(--color-brand)] text-white rounded-md px-4 py-2 text-sm font-medium hover:bg-[var(--color-brand-dark)] transition-colors disabled:opacity-60 shrink-0"
              >
                {pendingPlan === target ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Sparkles size={14} />
                )}
                Upgrade to {PLAN_COPY[target].name}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-border bg-surface-2 py-8 text-center">
          <Check size={24} className="text-success mx-auto mb-2" />
          <p className="text-sm font-medium text-text-primary">You're on the top plan</p>
          <p className="text-xs text-text-muted">Enjoy unlimited access to every Lumio feature.</p>
        </div>
      )}
    </div>
  );
}
