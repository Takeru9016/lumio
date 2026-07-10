import { clerkClient } from "@clerk/nextjs/server";
import { headers } from "next/headers";
import { Webhook } from "svix";
import { seatLimitForPlan } from "@/constants/plans";
import type { Role } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { WelcomeEmail } from "@/lib/emails/welcome";
import { createNotification } from "@/lib/notifications";
import { generateUniqueTenantSlug } from "@/lib/org-slug";
import { resend } from "@/lib/resend";

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
    unsafe_metadata: {
      role?: string;
      orgName?: string;
    };
    deleted?: boolean;
  };
};

// Trusted source (Clerk publicMetadata, only ever written by our own backend). Includes
// SUPER_ADMIN — that value only ever reaches publicMetadata via the Super Admin panel
// or a manual grant, never directly from a user.
function resolveRole(raw: string | undefined): Role {
  const map: Record<string, Role> = {
    STUDENT: "STUDENT",
    INSTRUCTOR: "INSTRUCTOR",
    ORG_ADMIN: "ORG_ADMIN",
    SUPER_ADMIN: "SUPER_ADMIN",
  };
  return raw ? (map[raw.toUpperCase()] ?? "STUDENT") : "STUDENT";
}

// Untrusted source (Clerk unsafeMetadata, set client-side at sign-up). SUPER_ADMIN is
// deliberately excluded — that privilege must never be grantable by the signing-up user.
function resolveSelfServeRole(raw: string | undefined): Role {
  const map: Record<string, Role> = {
    STUDENT: "STUDENT",
    INSTRUCTOR: "INSTRUCTOR",
    ORG_ADMIN: "ORG_ADMIN",
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
    const primaryEmail = data.email_addresses.find((e) => e.id === data.primary_email_address_id);
    const email = primaryEmail?.email_address ?? data.email_addresses[0]?.email_address;
    if (!email) {
      return Response.json({ error: "No email found" }, { status: 400 });
    }

    const name = [data.first_name, data.last_name].filter(Boolean).join(" ") || null;

    // Authoritative source for invited instructors/students: our own Invitation row,
    // looked up by email. Deliberately not relying on Clerk's publicMetadata
    // propagating onto this webhook payload — that's a timing assumption this code
    // shouldn't depend on when a DB-backed lookup is just as easy and always correct.
    const pendingInvitation = await db.invitation.findFirst({
      where: { email: email.toLowerCase(), status: "PENDING" },
      select: { id: true, tenantId: true, role: true, invitedById: true },
    });

    if (pendingInvitation) {
      await db.$transaction([
        db.user.create({
          data: {
            clerkId: data.id,
            email,
            name,
            avatarUrl: data.image_url,
            role: pendingInvitation.role,
            plan: "FREE",
            tenantId: pendingInvitation.tenantId,
          },
        }),
        db.invitation.update({
          where: { id: pendingInvitation.id },
          data: { status: "ACCEPTED" },
        }),
      ]);

      const client = await clerkClient();
      await client.users.updateUserMetadata(data.id, {
        publicMetadata: { role: pendingInvitation.role },
      });

      await createNotification({
        userId: pendingInvitation.invitedById,
        tenantId: pendingInvitation.tenantId,
        type: "INVITATION_ACCEPTED",
        title: "Invitation accepted",
        body: `${name ?? email} joined as ${pendingInvitation.role.toLowerCase()}`,
        link: "/org/teams",
      }).catch(() => {});

      resend.emails
        .send({
          from: "Lumio <hello@lumio.io>",
          to: email,
          subject: "Welcome to Lumio",
          react: WelcomeEmail({
            name: name ?? email.split("@")[0],
            dashboardUrl: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard`,
          }),
        })
        .catch(() => {});

      return Response.json({ received: true });
    }

    let role = resolveSelfServeRole(data.unsafe_metadata.role);
    const orgName = data.unsafe_metadata.orgName?.trim();

    // ORG_ADMIN requires a Tenant to exist — without a name to create one from, this
    // is either malformed input or a bypass of the sign-up form's required field.
    // Falling back to STUDENT keeps that case safe rather than creating a blank org.
    if (role === "ORG_ADMIN" && (!orgName || orgName.length > 100)) {
      role = "STUDENT";
    }

    if (role === "ORG_ADMIN" && orgName) {
      const slug = await generateUniqueTenantSlug(orgName);
      await db.$transaction(async (tx) => {
        const tenant = await tx.tenant.create({
          data: { name: orgName, slug, seatLimit: seatLimitForPlan("FREE") },
        });
        await tx.user.create({
          data: {
            clerkId: data.id,
            email,
            name,
            avatarUrl: data.image_url,
            role: "ORG_ADMIN",
            plan: "FREE",
            tenantId: tenant.id,
          },
        });
      });
    } else {
      await db.user.create({
        data: {
          clerkId: data.id,
          email,
          name,
          avatarUrl: data.image_url,
          role,
          plan: "FREE",
        },
      });
    }

    // Promote the now-validated role into Clerk's trusted publicMetadata. From this
    // point on, publicMetadata.role — not the client-supplied unsafeMetadata — is the
    // source of truth for every future user.updated event.
    const client = await clerkClient();
    await client.users.updateUserMetadata(data.id, { publicMetadata: { role } });

    // Fire-and-forget — email failure must not roll back the webhook ack
    resend.emails
      .send({
        from: "Lumio <hello@lumio.io>",
        to: email,
        subject: "Welcome to Lumio",
        react: WelcomeEmail({
          name: name ?? email.split("@")[0],
          dashboardUrl: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard`,
        }),
      })
      .catch(() => {});
  }

  if (type === "user.updated") {
    const primaryEmail = data.email_addresses.find((e) => e.id === data.primary_email_address_id);
    const email = primaryEmail?.email_address;

    await db.user.update({
      where: { clerkId: data.id },
      data: {
        ...(email ? { email } : {}),
        name: [data.first_name, data.last_name].filter(Boolean).join(" ") || null,
        avatarUrl: data.image_url,
        // Only touch role when publicMetadata actually carries one — an absent value
        // must never be read as "demote to STUDENT" (e.g. a plain name edit in Clerk
        // still sends the full user object, but a user promoted before this field
        // existed would have no publicMetadata.role at all).
        ...(data.public_metadata.role !== undefined
          ? { role: resolveRole(data.public_metadata.role) }
          : {}),
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
