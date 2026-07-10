import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { createNotification } from "@/lib/notifications";

const bodySchema = z.object({
  status: z.enum(["APPROVED", "DENIED"]),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true, role: true, tenantId: true },
  });
  if (!dbUser || dbUser.role !== "ORG_ADMIN" || !dbUser.tenantId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const raw = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const existing = await db.orgRequest.findUnique({
    where: { id },
    select: {
      id: true,
      tenantId: true,
      type: true,
      status: true,
      requesterId: true,
      payload: true,
    },
  });
  if (!existing || existing.tenantId !== dbUser.tenantId) {
    return NextResponse.json({ error: "Request not found" }, { status: 404 });
  }
  if (existing.status !== "PENDING") {
    return NextResponse.json({ error: "Request already resolved" }, { status: 409 });
  }

  const updated = await db.orgRequest.update({
    where: { id },
    data: { status: parsed.data.status, resolvedById: dbUser.id, resolvedAt: new Date() },
  });

  // Points back at the instructor's own requests page — they can't reach
  // /org/teams (org-admin only), so any admin-side deep link belongs in the
  // admin's inbox UI instead, not in this notification.
  await createNotification({
    userId: existing.requesterId,
    tenantId: dbUser.tenantId,
    type: "ORG_REQUEST_RESOLVED",
    title: parsed.data.status === "APPROVED" ? "Request approved" : "Request denied",
    body: `Your ${existing.type.replaceAll("_", " ").toLowerCase()} request was ${parsed.data.status.toLowerCase()}.`,
    link: "/instructor/requests",
  }).catch(() => {});

  return NextResponse.json({ request: updated });
}
