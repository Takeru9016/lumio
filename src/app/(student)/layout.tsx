import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import { ErrorBoundary, Sidebar, TopNav } from "@/components";

import { db } from "@/lib/db";
import { getRoleDashboard } from "@/lib/role-redirect";
import { getTenantCss } from "@/lib/tenant-css";

export const dynamic = "force-dynamic";

export default async function StudentLayout({ children }: { children: React.ReactNode }) {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const user = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true, role: true, currentStreak: true, tenantId: true },
  });

  if (!user || user.role !== "STUDENT") {
    redirect(user ? getRoleDashboard(user.role) : "/onboarding");
  }

  const [unreadCount, tenant] = await Promise.all([
    db.notification.count({ where: { userId: user.id, isRead: false } }),
    user.tenantId
      ? db.tenant.findUnique({
          where: { id: user.tenantId },
          select: { id: true, brandColor: true, logoUrl: true },
        })
      : null,
  ]);

  // Nested layouts can't render <html>, so the per-tenant CSS is scoped to this
  // wrapper div via [data-tenant] and cascades to Sidebar/TopNav/main — same
  // mechanism the org layout uses, so students/instructors see their org's
  // brand color too, not just org admins.
  const tenantCss = tenant ? getTenantCss(tenant) : "";

  return (
    <div data-tenant={tenant?.id} className="flex h-screen overflow-hidden">
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: tenantCss contains only hex-validated custom-property values — getTenantCss rejects any non-hex brandColor, and the PATCH route validates before persisting. */}
      {tenantCss && <style dangerouslySetInnerHTML={{ __html: tenantCss }} />}
      <ErrorBoundary>
        <Sidebar role="STUDENT" />
      </ErrorBoundary>
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <TopNav
          showAiBadge
          currentStreak={user.currentStreak}
          initialUnreadCount={unreadCount}
          logoUrl={tenant?.logoUrl ?? null}
        />
        <main className="flex-1 overflow-y-auto">
          <ErrorBoundary>{children}</ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
