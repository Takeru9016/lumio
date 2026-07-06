import type { NextRequest } from "next/server";
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
    select: { id: true, tenantId: true },
  });

  for (const user of expired) {
    await db.$transaction([
      db.user.update({
        where: { id: user.id },
        data: {
          plan: "FREE",
          subscriptionStatus: null,
          cancelAtPeriodEnd: false,
          scheduledDowngradeAt: null,
          razorpaySubId: null,
        },
      }),
      ...(user.tenantId
        ? [
            db.tenant.update({
              where: { id: user.tenantId },
              data: { plan: "FREE", razorpaySubId: null },
            }),
            db.user.updateMany({
              where: { tenantId: user.tenantId },
              data: { plan: "FREE" },
            }),
          ]
        : []),
    ]);
  }

  return Response.json({ downgraded: expired.length });
}
