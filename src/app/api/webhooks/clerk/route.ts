import { headers } from "next/headers";
import { Webhook } from "svix";

import { db } from "@/lib";

import type { Role } from "@/generated/prisma/client";

type ClerkWebhookEvent = {
  type: string;
  data: {
    id: string;
    email_addresses: Array<{ email_address: string; id: string }>;
    primary_email_address_id: string;
    first_name: string | null;
    last_name: string | null;
    image_url: string | null;
    public_metadata: {
      role?: string;
    };
    deleted?: boolean;
  };
};

function resolveRole(raw: string | undefined): Role {
  const map: Record<string, Role> = {
    STUDENT: "STUDENT",
    INSTRUCTOR: "INSTRUCTOR",
    ORG_ADMIN: "ORG_ADMIN",
    SUPER_ADMIN: "SUPER_ADMIN",
  };
  return raw ? (map[raw.toUpperCase()] ?? "STUDENT") : "STUDENT";
}

export async function POST(req: Request) {
  const webhookSecret = process.env.CLERK_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return Response.json({ error: "Missing webhook secret" }, { status: 500 });
  }

  const headerList = await headers();
  const svixId = headerList.get("svix-id");
  const svixTimestamp = headerList.get("svix-timestamp");
  const svixSignature = headerList.get("svix-signature");

  if (!svixId || !svixTimestamp || !svixSignature) {
    return Response.json({ error: "Missing svix headers" }, { status: 400 });
  }

  const payload = await req.text();
  const wh = new Webhook(webhookSecret);

  let event: ClerkWebhookEvent;
  try {
    event = wh.verify(payload, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as ClerkWebhookEvent;
  } catch {
    return Response.json({ error: "Invalid signature" }, { status: 400 });
  }

  const { type, data } = event;

  if (type === "user.created") {
    const primaryEmail = data.email_addresses.find(
      (e) => e.id === data.primary_email_address_id,
    );
    const email =
      primaryEmail?.email_address ?? data.email_addresses[0]?.email_address;
    if (!email) {
      return Response.json({ error: "No email found" }, { status: 400 });
    }

    await db.user.create({
      data: {
        clerkId: data.id,
        email,
        name:
          [data.first_name, data.last_name].filter(Boolean).join(" ") || null,
        avatarUrl: data.image_url,
        role: resolveRole(data.public_metadata.role),
        plan: "FREE",
      },
    });
  }

  if (type === "user.updated") {
    const primaryEmail = data.email_addresses.find(
      (e) => e.id === data.primary_email_address_id,
    );
    const email = primaryEmail?.email_address;

    await db.user.update({
      where: { clerkId: data.id },
      data: {
        ...(email ? { email } : {}),
        name:
          [data.first_name, data.last_name].filter(Boolean).join(" ") || null,
        avatarUrl: data.image_url,
        role: resolveRole(data.public_metadata.role),
      },
    });
  }

  if (type === "user.deleted") {
    await db.user.update({
      where: { clerkId: data.id },
      data: { deletedAt: new Date() },
    });
  }

  return Response.json({ received: true });
}
