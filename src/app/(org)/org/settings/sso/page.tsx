import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import { EnterpriseGateOverlay } from "@/components/billing/EnterpriseGateOverlay";
import { SsoSettings } from "@/components/org/SsoSettings";
import { db } from "@/lib/db";

export default async function OrgSsoPage() {
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
    select: { plan: true, samlEnabled: true, samlMetadataUrl: true },
  });
  if (!tenant) redirect("/onboarding");

  const isEnterprise = tenant.plan === "ENTERPRISE";

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1
            className="text-xl font-bold text-text-primary"
            style={{ fontFamily: "var(--font-heading)" }}
          >
            Single Sign-On (SSO)
          </h1>
          <p className="text-sm text-text-muted">
            Let members sign in through your organisation&apos;s identity provider via SAML.
          </p>
        </div>
        {!isEnterprise && (
          <span className="shrink-0 rounded-full bg-brand-light px-2.5 py-1 text-xs font-semibold text-[var(--color-brand-dark)]">
            Enterprise
          </span>
        )}
      </div>

      {isEnterprise ? (
        <SsoSettings
          initialSamlEnabled={tenant.samlEnabled}
          initialSamlMetadataUrl={tenant.samlMetadataUrl}
        />
      ) : (
        <div className="relative overflow-hidden rounded-lg border border-border bg-surface-1">
          {/* Muted preview of the SSO surface, behind the gate */}
          <div aria-hidden className="pointer-events-none select-none space-y-4 p-5 opacity-40">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-text-primary">Enable SAML SSO</p>
                <p className="text-xs text-text-muted">
                  Require members to authenticate through your identity provider.
                </p>
              </div>
              <div className="h-6 w-11 rounded-full bg-surface-3" />
            </div>
            <div className="border-t border-border pt-4">
              <p className="text-sm font-medium text-text-primary">IdP metadata URL</p>
              <div className="mt-2 h-9 w-full rounded-md border border-border bg-surface-2" />
            </div>
          </div>
          <EnterpriseGateOverlay feature="SAML SSO" />
        </div>
      )}
    </div>
  );
}
