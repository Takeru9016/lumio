import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import { ErrorBoundary, Sidebar, TopNav } from "@/components";

import { db } from "@/lib/db";
import { getRoleDashboard } from "@/lib/role-redirect";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const user = await db.user.findUnique({
    where: { clerkId: userId },
    select: { role: true },
  });

  if (!user || user.role !== "SUPER_ADMIN") {
    redirect(user ? getRoleDashboard(user.role) : "/onboarding");
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <ErrorBoundary>
        <Sidebar role="SUPER_ADMIN" />
      </ErrorBoundary>
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <TopNav />
        <main className="flex-1 overflow-y-auto">
          <ErrorBoundary>{children}</ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
