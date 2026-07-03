import { auth } from "@clerk/nextjs/server";

import { db } from "@/lib/db";

function isValidMetadataUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
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

  const tenant = await db.tenant.findUnique({
    where: { id: admin.tenantId },
    select: { plan: true },
  });
  if (!tenant) {
    return Response.json({ error: "No organisation found" }, { status: 400 });
  }
  if (tenant.plan !== "ENTERPRISE") {
    return Response.json(
      {
        error: "SAML SSO is available on the Enterprise plan.",
        upgradeRequired: true,
        requiredPlan: "ENTERPRISE",
      },
      { status: 403 }
    );
  }

  const body = (await req.json().catch(() => null)) as {
    samlEnabled?: boolean;
    samlMetadataUrl?: string | null;
  } | null;
  if (!body || typeof body.samlEnabled !== "boolean") {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const rawUrl = typeof body.samlMetadataUrl === "string" ? body.samlMetadataUrl.trim() : "";

  if (body.samlEnabled) {
    if (!rawUrl) {
      return Response.json(
        { error: "An IdP metadata URL is required to enable SSO." },
        { status: 400 }
      );
    }
    if (!isValidMetadataUrl(rawUrl)) {
      return Response.json({ error: "IdP metadata URL must be a valid URL." }, { status: 400 });
    }
  }

  const updated = await db.tenant.update({
    where: { id: admin.tenantId },
    data: {
      samlEnabled: body.samlEnabled,
      samlMetadataUrl: rawUrl === "" ? null : rawUrl,
    },
    select: { samlEnabled: true, samlMetadataUrl: true },
  });

  return Response.json({ success: true, tenant: updated });
}
