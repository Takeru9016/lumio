import { auth } from "@clerk/nextjs/server";
import { ChevronRight, CreditCard, Palette } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { db } from "@/lib/db";

const PLAN_NAME: Record<string, string> = {
  FREE: "Free",
  STARTER: "Starter",
  PRO: "Pro",
  ENTERPRISE: "Enterprise",
};

export default async function OrgSettingsPage() {
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
    select: { name: true, slug: true, plan: true, seatCount: true, seatLimit: true },
  });
  if (!tenant) redirect("/onboarding");

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div>
        <h1
          className="text-xl font-bold text-text-primary"
          style={{ fontFamily: "var(--font-heading)" }}
        >
          Settings
        </h1>
        <p className="text-sm text-text-muted">Manage your organisation.</p>
      </div>

      {/* Organisation profile */}
      <div className="space-y-4 rounded-lg border border-border bg-surface-1 p-5">
        <p className="text-xs text-text-muted">Organisation</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="text-xs text-text-muted">Name</p>
            <p className="text-sm font-semibold text-text-primary">{tenant.name}</p>
          </div>
          <div>
            <p className="text-xs text-text-muted">Workspace URL</p>
            <p className="text-sm font-semibold text-text-primary">lumio.io/{tenant.slug}</p>
          </div>
          <div>
            <p className="text-xs text-text-muted">Plan</p>
            <p className="text-sm font-semibold text-text-primary">
              {PLAN_NAME[tenant.plan] ?? tenant.plan}
            </p>
          </div>
          <div>
            <p className="text-xs text-text-muted">Seats</p>
            <p className="text-sm font-semibold text-text-primary">
              {tenant.seatCount} / {tenant.seatLimit}
            </p>
          </div>
        </div>
        <p className="border-t border-border pt-3 text-xs text-text-muted">
          Organisation details are managed via Clerk. Visit your organisation settings to rename the
          workspace or manage members.
        </p>
      </div>

      {/* Billing link */}
      <Link
        href="/org/settings/billing"
        className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-1 p-5 transition-colors hover:bg-surface-2"
      >
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-brand-light text-[var(--color-brand)]">
            <CreditCard size={18} />
          </div>
          <div>
            <p className="text-sm font-semibold text-text-primary">Billing & Plan</p>
            <p className="text-xs text-text-muted">Manage your plan, seats, and subscription.</p>
          </div>
        </div>
        <ChevronRight size={18} className="text-text-muted" />
      </Link>

      {/* Branding link */}
      <Link
        href="/org/settings/branding"
        className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-1 p-5 transition-colors hover:bg-surface-2"
      >
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-brand-light text-[var(--color-brand)]">
            <Palette size={18} />
          </div>
          <div>
            <p className="text-sm font-semibold text-text-primary">Branding</p>
            <p className="text-xs text-text-muted">Customise your logo and brand colour.</p>
          </div>
        </div>
        <ChevronRight size={18} className="text-text-muted" />
      </Link>
    </div>
  );
}
