import crypto from "node:crypto";
import type { Plan } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
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

      await db.user.updateMany({
        where: { clerkId },
        data: {
          plan: rawPlan,
          subscriptionStatus: "ACTIVE",
          currentPeriodEnd: toDate(sub?.current_end),
        },
      });
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

      // Record the cancellation; a cron flips plan → FREE once the period ends.
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
        html: `
          <p>Hi ${user.name ?? "there"},</p>
          <p>We couldn't process your latest Lumio subscription payment, so your account is now marked <strong>past due</strong>.</p>
          <p>Please update your payment method to keep your plan active and avoid losing access to premium features.</p>
          <p><a href="${process.env.NEXT_PUBLIC_APP_URL}/settings">Update payment method →</a></p>
          <p>— The Lumio team</p>
        `,
      });
      break;
    }

    default:
      // Unhandled event — acknowledge so Razorpay stops retrying.
      break;
  }

  return Response.json({ received: true });
}
