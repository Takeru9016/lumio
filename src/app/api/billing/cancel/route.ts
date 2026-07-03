import { auth } from "@clerk/nextjs/server";

import { db } from "@/lib/db";
import { razorpay } from "@/lib/razorpay";

export async function POST() {
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

  const tenant = await db.tenant.findUnique({
    where: { id: admin.tenantId },
    select: { razorpaySubId: true },
  });
  if (!tenant?.razorpaySubId) {
    return Response.json({ error: "No active subscription to cancel." }, { status: 400 });
  }

  // Subscription period/status lives on the user who created the subscription.
  const subOwner = await db.user.findFirst({
    where: { tenantId: admin.tenantId, razorpaySubId: tenant.razorpaySubId },
    select: { id: true, currentPeriodEnd: true },
  });

  try {
    // Positional `1` = cancel at cycle end (SDK signature is not an object).
    // The subscription stays ACTIVE until currentPeriodEnd, then reverts to FREE.
    await razorpay.subscriptions.cancel(tenant.razorpaySubId, 1);
  } catch (err) {
    console.error("[razorpay] cancel failed", err);
    return Response.json(
      { error: "Failed to cancel subscription. Please try again." },
      { status: 502 }
    );
  }

  // Flag the subscription owner; the subscription.cancelled webhook later sets
  // scheduledDowngradeAt, and a cron flips plan → FREE at period end.
  if (subOwner) {
    await db.user.update({
      where: { id: subOwner.id },
      data: { cancelAtPeriodEnd: true },
    });
  }

  return Response.json({
    success: true,
    cancellationDate: subOwner?.currentPeriodEnd ?? null,
  });
}
