"use client";

import { format } from "date-fns";
import { toast } from "gooey-toast";
import { Check, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { PLAN_LIMITS } from "@/constants/plans";
import type { Plan } from "@/types";

type SubscriptionStatus = "ACTIVE" | "CANCELLED" | "PAST_DUE" | "PAUSED" | null;

const PLAN_ORDER: Plan[] = ["FREE", "STARTER", "PRO", "ENTERPRISE"];

const PLAN_COPY: Record<Plan, { name: string; price: string; blurb: string }> = {
  FREE: { name: "Free", price: "₹0", blurb: "1 course · no AI calls" },
  STARTER: { name: "Starter", price: "₹1,499/mo", blurb: "50 AI calls · 10 courses · 10 seats" },
  PRO: { name: "Pro", price: "₹4,999/mo", blurb: "200 AI calls · unlimited courses · 100 seats" },
  ENTERPRISE: {
    name: "Enterprise",
    price: "Custom",
    blurb: "Unlimited AI · SSO · custom domain",
  },
};

const STATUS_BADGE: Record<
  NonNullable<SubscriptionStatus>,
  { label: string; className: string }
> = {
  ACTIVE: { label: "Active", className: "text-success bg-success-bg" },
  CANCELLED: { label: "Cancelled", className: "text-text-muted bg-surface-3" },
  PAST_DUE: { label: "Past due", className: "text-danger bg-danger-bg" },
  PAUSED: { label: "Paused", className: "text-text-muted bg-surface-3" },
};

interface PlanManagementProps {
  plan: Plan;
  subscriptionStatus: SubscriptionStatus;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  seatCount: number;
  seatLimit: number;
  aiCallsUsed: number;
}

function formatLimit(limit: number): string {
  return limit === Number.POSITIVE_INFINITY ? "Unlimited" : limit.toLocaleString("en-IN");
}

function ProgressBar({ used, limit }: { used: number; limit: number }) {
  const unlimited = limit === Number.POSITIVE_INFINITY;
  const pct = unlimited || limit === 0 ? 0 : Math.min(100, Math.round((used / limit) * 100));
  const over = !unlimited && used >= limit && limit > 0;

  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-surface-3">
      <div
        className={`h-full rounded-full transition-all ${over ? "bg-danger" : "bg-[var(--color-brand)]"}`}
        style={{ width: unlimited ? "100%" : `${pct}%` }}
      />
    </div>
  );
}

export function PlanManagement({
  plan,
  subscriptionStatus,
  currentPeriodEnd,
  cancelAtPeriodEnd,
  seatCount,
  seatLimit,
  aiCallsUsed,
}: PlanManagementProps) {
  const router = useRouter();
  const [pendingPlan, setPendingPlan] = useState<Plan | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isReactivating, setIsReactivating] = useState(false);

  const limits = PLAN_LIMITS[plan];
  const perSeatAi = limits.aiCallsPerMonth;
  const aiLimit =
    perSeatAi === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : perSeatAi * Math.max(seatCount, 1);

  const renewalDate = currentPeriodEnd ? format(new Date(currentPeriodEnd), "d MMM yyyy") : null;
  const isPaid = plan !== "FREE";
  const hasSub = subscriptionStatus != null;

  async function handleChangePlan(target: Plan) {
    setPendingPlan(target);
    try {
      const res = await fetch("/api/billing/change-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPlan: target }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(data?.error ?? "Couldn't change plan");

      toast.success({
        title: `Switched to ${PLAN_COPY[target].name}`,
        description: "Billing updates at the end of your current cycle.",
      });
      router.refresh();
    } catch (err) {
      toast.error({ title: err instanceof Error ? err.message : "Couldn't change plan" });
    } finally {
      setPendingPlan(null);
    }
  }

  async function handleCancel() {
    setIsCancelling(true);
    try {
      const res = await fetch("/api/billing/cancel", { method: "POST" });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(data?.error ?? "Couldn't cancel subscription");

      toast.success({
        title: "Subscription cancelled",
        description: renewalDate
          ? `Your plan reverts to Free on ${renewalDate}.`
          : "Your plan reverts to Free at the end of the billing cycle.",
      });
      router.refresh();
    } catch (err) {
      toast.error({ title: err instanceof Error ? err.message : "Couldn't cancel subscription" });
    } finally {
      setIsCancelling(false);
    }
  }

  async function handleReactivate() {
    setIsReactivating(true);
    try {
      const res = await fetch("/api/billing/reactivate", { method: "POST" });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(data?.error ?? "Couldn't reactivate subscription");

      toast.success({ title: "Subscription reactivated" });
      router.refresh();
    } catch (err) {
      toast.error({
        title: err instanceof Error ? err.message : "Couldn't reactivate subscription",
      });
    } finally {
      setIsReactivating(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* a) Current plan card */}
      <div className="space-y-4 rounded-lg border border-border bg-surface-1 p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs text-text-muted">Current plan</p>
            <div className="flex items-center gap-2">
              <p className="text-lg font-bold text-text-primary">{PLAN_COPY[plan].name}</p>
              <span className="rounded-full bg-brand-light px-2 py-0.5 text-[11px] font-semibold text-[var(--color-brand-dark)]">
                {PLAN_COPY[plan].price}
              </span>
            </div>
          </div>
          {hasSub && (
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_BADGE[subscriptionStatus].className}`}
            >
              {STATUS_BADGE[subscriptionStatus].label}
            </span>
          )}
        </div>

        {isPaid && renewalDate && (
          <p className="text-xs text-text-muted">
            {cancelAtPeriodEnd
              ? `Cancels — reverts to Free on ${renewalDate}`
              : `Renews on ${renewalDate}`}
          </p>
        )}

        <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
          {/* AI quota */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium text-text-primary">✦ AI calls</span>
              <span className="text-text-muted">
                {aiCallsUsed.toLocaleString("en-IN")} / {formatLimit(aiLimit)}
              </span>
            </div>
            <ProgressBar used={aiCallsUsed} limit={aiLimit} />
            <p className="text-[11px] text-text-muted">Pooled across all seats this month</p>
          </div>

          {/* Seats */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium text-text-primary">Seats</span>
              <span className="text-text-muted">
                {seatCount} / {formatLimit(seatLimit)}
              </span>
            </div>
            <ProgressBar used={seatCount} limit={seatLimit} />
            <p className="text-[11px] text-text-muted">Members assigned to your organisation</p>
          </div>
        </div>
      </div>

      {/* b) Plan selector */}
      <div className="space-y-3">
        <p className="text-sm font-semibold text-text-primary">Change plan</p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {PLAN_ORDER.map((p) => {
            const isCurrent = p === plan;
            const isFree = p === "FREE";
            return (
              <div
                key={p}
                className={`flex flex-col rounded-lg border p-4 ${
                  isCurrent
                    ? "border-[var(--color-brand)] bg-brand-light"
                    : "border-border bg-surface-1"
                }`}
              >
                <div className="flex-1">
                  <p className="text-sm font-bold text-text-primary">{PLAN_COPY[p].name}</p>
                  <p className="mb-2 text-sm font-semibold text-[var(--color-brand-dark)]">
                    {PLAN_COPY[p].price}
                  </p>
                  <p className="text-xs text-text-muted">{PLAN_COPY[p].blurb}</p>
                </div>
                <div className="mt-4">
                  {isCurrent ? (
                    <span className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-surface-3 px-3 py-2 text-sm font-medium text-text-muted">
                      <Check size={14} /> Current plan
                    </span>
                  ) : isFree ? (
                    <span className="block text-center text-[11px] text-text-muted">
                      Cancel your plan to revert to Free
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleChangePlan(p)}
                      disabled={pendingPlan !== null}
                      className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-[var(--color-brand)] px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--color-brand-dark)] disabled:opacity-60"
                    >
                      {pendingPlan === p && <Loader2 size={14} className="animate-spin" />}
                      Switch to this plan
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <p className="text-[11px] text-text-muted">
          Plan changes take effect at the end of your current billing cycle.
        </p>
      </div>

      {/* c) Cancel / reactivate */}
      {isPaid && (
        <div className="rounded-lg border border-border bg-surface-1 p-5">
          {cancelAtPeriodEnd ? (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-text-primary">Subscription cancelled</p>
                <p className="text-xs text-text-muted">
                  {renewalDate
                    ? `Your plan stays active until ${renewalDate}, then reverts to Free.`
                    : "Your plan reverts to Free at the end of the billing cycle."}
                </p>
              </div>
              <button
                type="button"
                onClick={handleReactivate}
                disabled={isReactivating}
                className="inline-flex items-center justify-center gap-1.5 rounded-md bg-[var(--color-brand)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--color-brand-dark)] disabled:opacity-60"
              >
                {isReactivating && <Loader2 size={14} className="animate-spin" />}
                Reactivate
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-text-primary">Cancel subscription</p>
                <p className="text-xs text-text-muted">
                  Your plan will revert to Free at the end of the current billing cycle.
                </p>
              </div>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex items-center justify-center rounded-md border border-danger px-4 py-2 text-sm font-medium text-danger transition-colors hover:bg-danger-bg disabled:opacity-60"
                  >
                    Cancel subscription
                  </button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogTitle>Cancel your subscription?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Your organisation stays on {PLAN_COPY[plan].name}
                    {renewalDate ? ` until ${renewalDate}` : " until the end of the billing cycle"},
                    then reverts to the Free plan. AI calls and extra seats will be removed.
                  </AlertDialogDescription>
                  <AlertDialogFooter>
                    <AlertDialogCancel disabled={isCancelling}>Keep plan</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleCancel}
                      disabled={isCancelling}
                      className="bg-danger text-white hover:bg-danger/90"
                    >
                      {isCancelling && <Loader2 size={14} className="mr-1.5 animate-spin" />}
                      Cancel subscription
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
