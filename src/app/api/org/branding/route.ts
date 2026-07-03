import { auth } from "@clerk/nextjs/server";

import { db } from "@/lib/db";

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function isValidLogoUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

export async function PATCH(req: Request) {
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

  const body = (await req.json().catch(() => null)) as {
    brandColor?: string | null;
    logoUrl?: string | null;
  } | null;
  if (!body) {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const data: { brandColor?: string | null; logoUrl?: string | null } = {};

  if (body.brandColor !== undefined) {
    if (body.brandColor === null || body.brandColor === "") {
      data.brandColor = null;
    } else if (HEX_COLOR.test(body.brandColor)) {
      data.brandColor = body.brandColor.toLowerCase();
    } else {
      return Response.json(
        { error: "Brand colour must be a 6-digit hex value (e.g. #4f6ef7)." },
        { status: 400 }
      );
    }
  }

  if (body.logoUrl !== undefined) {
    if (body.logoUrl === null || body.logoUrl === "") {
      data.logoUrl = null;
    } else if (isValidLogoUrl(body.logoUrl)) {
      data.logoUrl = body.logoUrl;
    } else {
      return Response.json({ error: "Logo URL must be a valid https URL." }, { status: 400 });
    }
  }

  if (Object.keys(data).length === 0) {
    return Response.json({ error: "Nothing to update." }, { status: 400 });
  }

  const tenant = await db.tenant.update({
    where: { id: admin.tenantId },
    data,
    select: { brandColor: true, logoUrl: true },
  });

  return Response.json({ tenant });
}
