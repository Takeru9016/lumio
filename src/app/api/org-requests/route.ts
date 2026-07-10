import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { createNotification } from "@/lib/notifications";

const PAYLOAD_SCHEMAS = {
  SEAT_INCREASE: z.object({ requestedSeats: z.number().int().positive() }),
  ACCOUNT_CREATE: z.object({
    name: z.string().min(1).max(100).optional(),
    email: z.email(),
    role: z.enum(["STUDENT", "INSTRUCTOR"]),
  }),
  COURSE_CAPACITY: z.object({ requestedCourses: z.number().int().positive() }),
  OTHER: z.object({}).strict(),
} as const;

const bodySchema = z.object({
  type: z.enum(["SEAT_INCREASE", "ACCOUNT_CREATE", "COURSE_CAPACITY", "OTHER"]),
  payload: z.unknown(),
  message: z.string().max(1000).optional(),
});

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true, role: true, tenantId: true },
  });
  if (!dbUser || dbUser.role !== "INSTRUCTOR" || !dbUser.tenantId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const raw = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const { type, payload, message } = parsed.data;
  const payloadParsed = PAYLOAD_SCHEMAS[type].safeParse(payload);
  if (!payloadParsed.success) {
    return NextResponse.json(
      { error: `Invalid payload for ${type}`, issues: payloadParsed.error.issues },
      { status: 400 }
    );
  }

  const request = await db.orgRequest.create({
    data: {
      tenantId: dbUser.tenantId,
      requesterId: dbUser.id,
      type,
      payload: payloadParsed.data,
      message: message ?? null,
    },
  });

  const admins = await db.user.findMany({
    where: { tenantId: dbUser.tenantId, role: "ORG_ADMIN", deletedAt: null },
    select: { id: true },
  });
  await Promise.all(
    admins.map((admin) =>
      createNotification({
        userId: admin.id,
        tenantId: dbUser.tenantId as string,
        type: "ORG_REQUEST_CREATED",
        title: "New request from an instructor",
        body: message?.trim() || `${type.replaceAll("_", " ").toLowerCase()} request`,
        link: "/org/requests",
      }).catch(() => {})
    )
  );

  return NextResponse.json({ request }, { status: 201 });
}

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true, role: true, tenantId: true },
  });
  if (!dbUser || !dbUser.tenantId)
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  if (dbUser.role === "ORG_ADMIN") {
    const requests = await db.orgRequest.findMany({
      where: { tenantId: dbUser.tenantId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        type: true,
        payload: true,
        message: true,
        status: true,
        createdAt: true,
        resolvedAt: true,
        requester: { select: { name: true, email: true } },
      },
    });
    return NextResponse.json({ requests });
  }

  if (dbUser.role === "INSTRUCTOR") {
    const requests = await db.orgRequest.findMany({
      where: { requesterId: dbUser.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        type: true,
        payload: true,
        message: true,
        status: true,
        createdAt: true,
        resolvedAt: true,
      },
    });
    return NextResponse.json({ requests });
  }

  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}
