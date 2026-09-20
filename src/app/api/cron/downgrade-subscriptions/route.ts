import type { NextRequest } from "next/server";
import { isLiveSubscriptionStatus, seatLimitForPlan } from "@/constants/plans";
import { db } from "@/lib/db";

/**
 * Vercel Cron target (see vercel.json). Vercel automatically sends
 * `Authorization: Bearer $CRON_SECRET` on scheduled invocations when
 * CRON_SECRET is set as a project env var.
 */
function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const expired = await db.user.findMany({
    where: {
      subscriptionStatus: "CANCELLED",
      scheduledDowngradeAt: { lte: new Date() },
    },
    select: { id: true },
  });

  let downgraded = 0;
  for (const { id } of expired) {
    if (await processCancellation(id)) downgraded += 1;
  }

  return Response.json({ downgraded });
}

/**
 * A due cancellation is only a candidate: the webhook records it against a user,
 * and that user may no longer own the tenant's subscription (it was replaced) or
 * the record may have been re-armed by a late webhook. The tenant's own
 * `razorpaySubId` is the authority on which subscription is current, and the
 * tenant is downgraded only when nobody holding that id is in a live state.
 * Everything is re-read inside the transaction, and the tenant write is a
 * compare-and-set on the id that was read, so a subscription recorded meanwhile
 * (create-subscription) is never downgraded from stale state.
 */
async function processCancellation(userId: string): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const candidate = await tx.user.findFirst({
      where: {
        id: userId,
        subscriptionStatus: "CANCELLED",
        scheduledDowngradeAt: { lte: new Date() },
      },
      select: { id: true, tenantId: true },
    });
    if (!candidate) return false;

    const { tenantId } = candidate;
    const downgradeUser = () =>
      tx.user.update({
        where: { id: candidate.id },
        data: {
          plan: "FREE",
          subscriptionStatus: null,
          cancelAtPeriodEnd: false,
          scheduledDowngradeAt: null,
          razorpaySubId: null,
        },
      });

    if (!tenantId) {
      await downgradeUser();
      return true;
    }

    // Lock the tenant row before the liveness snapshot below. The tenant write
    // further down is a compare-and-set, but it re-checks only the tenant row:
    // an activation committing between the holder read and that write would
    // otherwise be downgraded from a stale snapshot. Taking the row lock first
    // serialises this transaction against the activation webhook, which also
    // writes the tenant row before touching any user row. Prisma exposes no
    // FOR UPDATE through its query API; the tagged template parameterises the id.
    await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR UPDATE`;

    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { razorpaySubId: true },
    });
    const currentSubId = tenant?.razorpaySubId ?? null;

    if (currentSubId) {
      // No unique constraint on User.razorpaySubId: judge by every holder of the
      // tenant's current id, never by one arbitrary row.
      const holders = await tx.user.findMany({
        where: { tenantId, razorpaySubId: currentSubId },
        select: { subscriptionStatus: true },
      });
      if (holders.some((holder) => isLiveSubscriptionStatus(holder.subscriptionStatus))) {
        // The tenant's current subscription is live, so this cancellation is
        // stale. Retire it (same reset as reactivate) so it is not re-read hourly.
        await tx.user.updateMany({
          where: { id: candidate.id, subscriptionStatus: "CANCELLED" },
          data: { scheduledDowngradeAt: null },
        });
        return false;
      }
    }

    const { count } = await tx.tenant.updateMany({
      where: { id: tenantId, razorpaySubId: currentSubId },
      data: { plan: "FREE", razorpaySubId: null, seatLimit: seatLimitForPlan("FREE") },
    });
    if (count !== 1) return false;

    await downgradeUser();
    await tx.user.updateMany({ where: { tenantId }, data: { plan: "FREE" } });
    return true;
  });
}
