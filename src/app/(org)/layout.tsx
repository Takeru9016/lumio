import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import { ErrorBoundary, Sidebar, TopNav } from "@/components";

import { db } from "@/lib/db";
import { getRoleDashboard } from "@/lib/role-redirect";
import { getTenantCss } from "@/lib/tenant-css";

export const dynamic = "force-dynamic";

export default async function OrgLayout({ children }: { children: React.ReactNode }) {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const user = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true, role: true, currentStreak: true, tenantId: true },
  });

  if (!user || user.role !== "ORG_ADMIN") {
    redirect(user ? getRoleDashboard(user.role) : "/onboarding");
  }

  const unreadCount = await db.notification.count({ where: { userId: user.id, isRead: false } });

  const tenant = user.tenantId
    ? await db.tenant.findUnique({
        where: { id: user.tenantId },
        select: { id: true, brandColor: true, logoUrl: true },
      })
    : null;

  // Nested layouts can't render <html>, so the per-tenant CSS is scoped to this
  // wrapper div via [data-tenant] and cascades to Sidebar/TopNav/main. Server-rendered,
  // so there's no flash of the default brand colour.
  const tenantCss = tenant ? getTenantCss(tenant) : "";

  return (
    <div data-tenant={tenant?.id} className="flex h-screen overflow-hidden">
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: tenantCss contains only hex-validated custom-property values — getTenantCss rejects any non-hex brandColor, and the PATCH route validates before persisting. */}
      {tenantCss && <style dangerouslySetInnerHTML={{ __html: tenantCss }} />}
      <ErrorBoundary>
        <Sidebar role="ORG_ADMIN" />
      </ErrorBoundary>
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <TopNav
          currentStreak={user.currentStreak}
          logoUrl={tenant?.logoUrl ?? null}
          initialUnreadCount={unreadCount}
        />
        <main className="flex-1 overflow-y-auto">
          <ErrorBoundary>{children}</ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
