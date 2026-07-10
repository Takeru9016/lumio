import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import { PlanManagement } from "@/components/billing/PlanManagement";
import { db } from "@/lib/db";

export default async function OrgBillingPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const admin = await db.user.findUnique({
    where: { clerkId: userId },
    select: { role: true, tenantId: true },
  });
  if (!admin || admin.role !== "ORG_ADMIN") redirect("/dashboard");
  if (!admin.tenantId) redirect("/onboarding");

  const tenant = await db.tenant.findUnique({
    where: { id: admin.tenantId },
    select: { plan: true, seatLimit: true, razorpaySubId: true },
  });
  if (!tenant) redirect("/onboarding");

  // Subscription status/period lives on the user who created the subscription,
  // not necessarily the admin viewing this page — look it up by the shared sub id.
  const [subOwner, aiUsage, activeMemberCount] = await Promise.all([
    tenant.razorpaySubId
      ? db.user.findFirst({
          where: { tenantId: admin.tenantId, razorpaySubId: tenant.razorpaySubId },
          select: {
            subscriptionStatus: true,
            currentPeriodEnd: true,
            cancelAtPeriodEnd: true,
          },
        })
      : null,
    db.user.aggregate({
      where: { tenantId: admin.tenantId },
      _sum: { aiCallsUsed: true },
    }),
    // `Tenant.seatCount` is never written anywhere in this codebase — the real
    // active-member count is used instead (matches org dashboard / teams page).
    db.user.count({ where: { tenantId: admin.tenantId, deletedAt: null } }),
  ]);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div>
        <h1
          className="text-xl font-bold text-text-primary"
          style={{ fontFamily: "var(--font-heading)" }}
        >
          Billing & Plan
        </h1>
        <p className="text-sm text-text-muted">
          Manage your organisation's plan, seats, and subscription.
        </p>
      </div>

      <PlanManagement
        plan={tenant.plan}
        subscriptionStatus={subOwner?.subscriptionStatus ?? null}
        currentPeriodEnd={subOwner?.currentPeriodEnd?.toISOString() ?? null}
        cancelAtPeriodEnd={subOwner?.cancelAtPeriodEnd ?? false}
        seatCount={activeMemberCount}
        seatLimit={tenant.seatLimit}
        aiCallsUsed={aiUsage._sum.aiCallsUsed ?? 0}
      />
    </div>
  );
}
