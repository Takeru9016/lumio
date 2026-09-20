import { isLiveSubscriptionStatus, seatLimitForPlan } from "@/constants/plans";
import {
  AuthContextError,
  requireAuthContext,
  requireRole,
  requireTenant,
} from "@/lib/auth/context";
import { db } from "@/lib/db";
import { razorpay } from "@/lib/razorpay";

const PAID_PLANS = ["STARTER", "PRO", "ENTERPRISE"] as const;
type PaidPlan = (typeof PAID_PLANS)[number];

function isPaidPlan(value: unknown): value is PaidPlan {
  return typeof value === "string" && (PAID_PLANS as readonly string[]).includes(value);
}

function planIdFor(plan: PaidPlan): string | undefined {
  switch (plan) {
    case "STARTER":
      return process.env.RAZORPAY_PLAN_STARTER;
    case "PRO":
      return process.env.RAZORPAY_PLAN_PRO;
    case "ENTERPRISE":
      return process.env.RAZORPAY_PLAN_ENTERPRISE;
  }
}

async function cancelOrphanedSubscription(subscriptionId: string): Promise<void> {
  try {
    await razorpay.subscriptions.cancel(subscriptionId, 0);
  } catch (err) {
    console.error("[razorpay] failed to cancel superseded subscription", subscriptionId, err);
  }
}

export async function POST(req: Request) {
  let ctx: Awaited<ReturnType<typeof requireAuthContext>>;
  try {
    ctx = await requireAuthContext();
    requireRole(ctx, ["ORG_ADMIN"]);
    requireTenant(ctx);
  } catch (err) {
    if (err instanceof AuthContextError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
  const { tenantId } = ctx;

  const body = (await req.json().catch(() => null)) as { plan?: unknown; seats?: unknown } | null;

  const plan = body?.plan;
  if (!isPaidPlan(plan)) {
    return Response.json(
      { error: "Invalid plan. Expected STARTER, PRO, or ENTERPRISE." },
      { status: 400 }
    );
  }

  const maxSeats = seatLimitForPlan(plan);
  const seats = body?.seats === undefined ? 1 : body?.seats;
  if (typeof seats !== "number" || !Number.isInteger(seats) || seats < 1 || seats > maxSeats) {
    return Response.json(
      { error: `Invalid seats. Expected a whole number from 1 to ${maxSeats} for ${plan}.` },
      { status: 400 }
    );
  }

  const planId = planIdFor(plan);
  if (!planId) {
    return Response.json(
      { error: `Razorpay plan ID not configured for ${plan}.` },
      { status: 500 }
    );
  }

  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { razorpaySubId: true },
  });
  if (!tenant) {
    return Response.json({ error: "No organisation found" }, { status: 400 });
  }

  const previousSubId = tenant.razorpaySubId;
  if (previousSubId) {
    // Subscription status lives on the user who created it — same lookup the
    // cancel and reactivate routes use.
    const subOwner = await db.user.findFirst({
      where: { tenantId, razorpaySubId: previousSubId },
      select: { subscriptionStatus: true },
    });
    if (subOwner && isLiveSubscriptionStatus(subOwner.subscriptionStatus)) {
      return Response.json(
        { error: "Your organisation already has a subscription. Change plans instead." },
        { status: 409 }
      );
    }
  }

  let subscription: { id: string };
  try {
    subscription = await razorpay.subscriptions.create({
      plan_id: planId,
      customer_notify: 1,
      quantity: seats,
      total_count: 120, // 10 years — effectively open-ended
      // `userId` is the Clerk id: the Razorpay webhook resolves the subscriber from it.
      notes: { userId: ctx.clerkId, plan, tenantId },
      // biome-ignore lint/suspicious/noExplicitAny: Razorpay SDK types are stricter than the accepted API shape
    } as any);
  } catch (err) {
    console.error("[razorpay] subscription create failed", err);
    return Response.json(
      { error: "Failed to create subscription. Please try again." },
      { status: 502 }
    );
  }

  let recorded: boolean;
  try {
    recorded = await db.$transaction(async (tx) => {
      // Compare-and-set: only replace the subscription id we read above, so a
      // concurrent request that already recorded its own subscription wins.
      const { count } = await tx.tenant.updateMany({
        where: { id: tenantId, razorpaySubId: previousSubId },
        data: { razorpaySubId: subscription.id },
      });
      if (count !== 1) return false;

      // A CANCELLED owner being replaced keeps its cancellation record on purpose:
      // the downgrade cron judges it against the tenant's current subscription, so
      // a replacement that goes live is kept and one that never activates is not
      // left paid forever. Clearing that record here would hide the tenant from it.
      await tx.user.update({
        where: { id: ctx.userId },
        data: { razorpaySubId: subscription.id },
      });
      return true;
    });
  } catch (err) {
    console.error("[billing] failed to record subscription", err);
    await cancelOrphanedSubscription(subscription.id);
    return Response.json(
      { error: "Failed to create subscription. Please try again." },
      { status: 500 }
    );
  }

  if (!recorded) {
    await cancelOrphanedSubscription(subscription.id);
    return Response.json(
      { error: "Another subscription was just created for your organisation." },
      { status: 409 }
    );
  }

  return Response.json({
    subscriptionId: subscription.id,
    razorpayKeyId: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
  });
}
