import { auth } from "@clerk/nextjs/server";

import { db } from "@/lib/db";

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
    return Response.json({ error: "No subscription to reactivate." }, { status: 400 });
  }

  const subOwner = await db.user.findFirst({
    where: { tenantId: admin.tenantId, razorpaySubId: tenant.razorpaySubId },
    select: { id: true, subscriptionStatus: true, cancelAtPeriodEnd: true },
  });

  // Reactivation is only valid inside the grace period: the cancellation was
  // requested (cancelAtPeriodEnd) but the sub is still ACTIVE until period end.
  // Once the subscription.cancelled webhook fires, status is CANCELLED and the
  // Razorpay subscription is genuinely dead — it must be recreated, not resumed.
  if (!subOwner || subOwner.subscriptionStatus !== "ACTIVE" || !subOwner.cancelAtPeriodEnd) {
    return Response.json(
      {
        error: "Subscription has already ended. Start a new subscription to continue.",
      },
      { status: 409 }
    );
  }

  // No Razorpay call: cancelAtPeriodEnd=1 keeps the sub ACTIVE until period end,
  // and Razorpay has no API to reverse a scheduled cancellation. Do NOT wire in
  // resume() (paused subs only) or cancelScheduledChanges() (pending plan updates
  // only) — neither undoes a cancellation. Clearing our flags is the reactivation.
  await db.user.update({
    where: { id: subOwner.id },
    data: { cancelAtPeriodEnd: false, scheduledDowngradeAt: null },
  });

  return Response.json({ success: true });
}
