import { auth } from "@clerk/nextjs/server";

import { db } from "@/lib/db";
import { razorpay } from "@/lib/razorpay";

type PaidPlan = "STARTER" | "PRO" | "ENTERPRISE";

const PLAN_ENV: Record<PaidPlan, string | undefined> = {
  STARTER: process.env.RAZORPAY_PLAN_STARTER,
  PRO: process.env.RAZORPAY_PLAN_PRO,
  ENTERPRISE: process.env.RAZORPAY_PLAN_ENTERPRISE,
};

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as {
    plan?: string;
    seats?: number;
  } | null;

  const plan = body?.plan as PaidPlan | undefined;
  if (!plan || !(plan in PLAN_ENV)) {
    return Response.json(
      { error: "Invalid plan. Expected STARTER, PRO, or ENTERPRISE." },
      { status: 400 }
    );
  }

  const planId = PLAN_ENV[plan];
  if (!planId) {
    return Response.json(
      { error: `Razorpay plan ID not configured for ${plan}.` },
      { status: 500 }
    );
  }

  const user = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true, tenantId: true },
  });
  if (!user) {
    return Response.json({ error: "User not found" }, { status: 404 });
  }

  const seats = body?.seats && body.seats > 0 ? Math.floor(body.seats) : 1;

  let subscription: { id: string };
  try {
    subscription = await razorpay.subscriptions.create({
      plan_id: planId,
      customer_notify: 1,
      quantity: seats,
      total_count: 120, // 10 years — effectively open-ended
      notes: { userId, plan },
      // biome-ignore lint/suspicious/noExplicitAny: Razorpay SDK types are stricter than the accepted API shape
    } as any);
  } catch (err) {
    console.error("[razorpay] subscription create failed", err);
    return Response.json(
      { error: "Failed to create subscription. Please try again." },
      { status: 502 }
    );
  }

  await db.user.update({
    where: { id: user.id },
    data: { razorpaySubId: subscription.id },
  });

  if (user.tenantId) {
    await db.tenant.update({
      where: { id: user.tenantId },
      data: { razorpaySubId: subscription.id },
    });
  }

  return Response.json({
    subscriptionId: subscription.id,
    razorpayKeyId: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
  });
}
