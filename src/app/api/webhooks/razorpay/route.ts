import crypto from "node:crypto";
import type { Plan } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { DunningEmail } from "@/lib/emails/dunning";
import { resend } from "@/lib/resend";

type SubscriptionEntity = {
  id: string;
  current_end?: number | null;
  notes?: { userId?: string; plan?: string } | null;
};

type PaymentEntity = {
  id: string;
  email?: string | null;
  notes?: { userId?: string; plan?: string } | null;
};

type RazorpayWebhook = {
  event: string;
  payload?: {
    subscription?: { entity?: SubscriptionEntity };
    payment?: { entity?: PaymentEntity };
  };
};

const PAID_PLANS = new Set<Plan>(["STARTER", "PRO", "ENTERPRISE"]);

function verifySignature(rawBody: string, signature: string | null): boolean {
  if (!signature) return false;

  const expected = crypto
    .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET!)
    .update(rawBody)
    .digest("hex");

  const expectedBuf = Buffer.from(expected);
  const signatureBuf = Buffer.from(signature);

  return (
    expectedBuf.length === signatureBuf.length && crypto.timingSafeEqual(expectedBuf, signatureBuf)
  );
}

function toDate(unixSeconds?: number | null): Date | null {
  return unixSeconds ? new Date(unixSeconds * 1000) : null;
}

export async function POST(req: Request) {
  const rawBody = await req.text();
  const signature = req.headers.get("x-razorpay-signature");

  if (!verifySignature(rawBody, signature)) {
    return Response.json({ error: "Invalid signature" }, { status: 400 });
  }

  let webhook: RazorpayWebhook;
  try {
    webhook = JSON.parse(rawBody) as RazorpayWebhook;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const sub = webhook.payload?.subscription?.entity;
  const payment = webhook.payload?.payment?.entity;

  switch (webhook.event) {
    case "subscription.activated": {
      const clerkId = sub?.notes?.userId;
      const rawPlan = sub?.notes?.plan as Plan | undefined;
      if (!clerkId || !rawPlan || !PAID_PLANS.has(rawPlan)) break;

      const subscriber = await db.user.findUnique({
        where: { clerkId },
        select: { id: true, tenantId: true },
      });
      if (!subscriber) break;

      await db.$transaction([
        db.user.update({
          where: { id: subscriber.id },
          data: {
            plan: rawPlan,
            subscriptionStatus: "ACTIVE",
            currentPeriodEnd: toDate(sub?.current_end),
          },
        }),
        // Org subscriptions: the whole tenant shares the plan tier, same as the
        // native change-plan flow (src/app/api/billing/change-plan/route.ts) —
        // otherwise Tenant.plan stays FREE forever on a tenant's first-ever
        // subscription, wrongly blocking Enterprise-gated features like SSO.
        ...(subscriber.tenantId
          ? [
              db.tenant.update({
                where: { id: subscriber.tenantId },
                data: { plan: rawPlan },
              }),
              db.user.updateMany({
                where: { tenantId: subscriber.tenantId },
                data: { plan: rawPlan },
              }),
            ]
          : []),
      ]);
      break;
    }

    case "subscription.charged": {
      const clerkId = sub?.notes?.userId;
      if (!clerkId) break;

      // Successful renewal — roll the period forward and reset the AI quota.
      await db.user.updateMany({
        where: { clerkId },
        data: {
          subscriptionStatus: "ACTIVE",
          currentPeriodEnd: toDate(sub?.current_end),
          aiCallsUsed: 0,
          aiQuotaResetAt: new Date(),
        },
      });
      break;
    }

    case "subscription.cancelled": {
      const clerkId = sub?.notes?.userId;
      if (!clerkId) break;

      // Record the cancellation; /api/cron/downgrade-subscriptions (hourly, see
      // vercel.json) flips plan → FREE once scheduledDowngradeAt passes.
      await db.user.updateMany({
        where: { clerkId },
        data: {
          subscriptionStatus: "CANCELLED",
          cancelAtPeriodEnd: false,
          scheduledDowngradeAt: toDate(sub?.current_end),
        },
      });
      break;
    }

    case "payment.failed": {
      const clerkId = payment?.notes?.userId;
      const email = payment?.email ?? undefined;

      const user = clerkId
        ? await db.user.findUnique({
            where: { clerkId },
            select: { id: true, email: true, name: true },
          })
        : email
          ? await db.user.findUnique({
              where: { email },
              select: { id: true, email: true, name: true },
            })
          : null;

      if (!user) break;

      await db.user.update({
        where: { id: user.id },
        data: { subscriptionStatus: "PAST_DUE" },
      });

      await resend.emails.send({
        from: "Lumio <no-reply@lumio.io>",
        to: user.email,
        subject: "Action needed: your Lumio payment failed",
        react: DunningEmail({
          name: user.name ?? "there",
          billingUrl: `${process.env.NEXT_PUBLIC_APP_URL}/settings?tab=plan`,
        }),
      });
      break;
    }

    default:
      // Unhandled event — acknowledge so Razorpay stops retrying.
      break;
  }

  return Response.json({ received: true });
}
