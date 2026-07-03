import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import { BrandingForm } from "@/components/org/BrandingForm";
import { db } from "@/lib/db";

export default async function OrgBrandingPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const admin = await db.user.findUnique({
    where: { clerkId: userId },
    select: { role: true, tenantId: true },
  });
  if (!admin || admin.role !== "ORG_ADMIN") redirect("/dashboard");
  if (!admin.tenantId) redirect("/onboarding");

  const tenant = await db.tenant.findUnique({
    where: { id: admin.tenantId },
    select: { name: true, brandColor: true, logoUrl: true },
  });
  if (!tenant) redirect("/onboarding");

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <h1
          className="text-xl font-bold text-text-primary"
          style={{ fontFamily: "var(--font-heading)" }}
        >
          Branding
        </h1>
        <p className="text-sm text-text-muted">Customise how Lumio looks for your organisation.</p>
      </div>

      <BrandingForm
        tenantName={tenant.name}
        initialBrandColor={tenant.brandColor}
        initialLogoUrl={tenant.logoUrl}
      />
    </div>
  );
}
