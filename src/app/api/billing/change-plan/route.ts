import { auth } from "@clerk/nextjs/server";

import { seatLimitForPlan } from "@/constants/plans";
import type { Plan } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { razorpay } from "@/lib/razorpay";

type PaidPlan = "STARTER" | "PRO" | "ENTERPRISE";

const PLAN_ENV: Record<PaidPlan, string | undefined> = {
  STARTER: process.env.RAZORPAY_PLAN_STARTER,
  PRO: process.env.RAZORPAY_PLAN_PRO,
  ENTERPRISE: process.env.RAZORPAY_PLAN_ENTERPRISE,
};

const PAID_PLANS = new Set<Plan>(["STARTER", "PRO", "ENTERPRISE"]);

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = await db.user.findUnique({
    where: { clerkId: userId },
    select: { role: true, tenantId: true },
  });
  if (!admin || admin.role !== "ORG_ADMIN") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!admin.tenantId) {
    return Response.json({ error: "No organisation found" }, { status: 400 });
  }

  const body = (await req.json().catch(() => null)) as { newPlan?: string } | null;
  const newPlan = body?.newPlan as Plan | undefined;
  if (!newPlan || !PAID_PLANS.has(newPlan)) {
    return Response.json(
      { error: "Invalid plan. Expected STARTER, PRO, or ENTERPRISE." },
      { status: 400 }
    );
  }

  const planId = PLAN_ENV[newPlan as PaidPlan];
  if (!planId) {
    return Response.json(
      { error: `Razorpay plan ID not configured for ${newPlan}.` },
      { status: 500 }
    );
  }

  const tenant = await db.tenant.findUnique({
    where: { id: admin.tenantId },
    select: { razorpaySubId: true },
  });
  if (!tenant?.razorpaySubId) {
    return Response.json(
      { error: "No active subscription to change. Start a subscription first." },
      { status: 400 }
    );
  }

  try {
    // Razorpay applies the plan swap at the end of the current billing cycle so
    // the org keeps the access it already paid for through period end.
    await razorpay.subscriptions.update(tenant.razorpaySubId, {
      plan_id: planId,
      schedule_change_at: "cycle_end",
    });
  } catch (err) {
    console.error("[razorpay] plan change failed", err);
    return Response.json({ error: "Failed to change plan. Please try again." }, { status: 502 });
  }

  // We update our own records immediately (per product spec) so the UI reflects
  // the new plan right away, even though Razorpay bills the new plan at cycle end.
  await db.$transaction([
    db.tenant.update({
      where: { id: admin.tenantId },
      data: { plan: newPlan, seatLimit: seatLimitForPlan(newPlan) },
    }),
    db.user.updateMany({
      where: { tenantId: admin.tenantId },
      data: { plan: newPlan },
    }),
  ]);

  return Response.json({ success: true, effectiveDate: "cycle_end" });
}
