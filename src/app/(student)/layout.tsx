import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import { ErrorBoundary, Sidebar, TopNav } from "@/components";

import { db } from "@/lib/db";
import { getRoleDashboard } from "@/lib/role-redirect";

export const dynamic = "force-dynamic";

export default async function StudentLayout({ children }: { children: React.ReactNode }) {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const user = await db.user.findUnique({
    where: { clerkId: userId },
    select: { role: true, currentStreak: true },
  });

  if (!user || user.role !== "STUDENT") {
    redirect(user ? getRoleDashboard(user.role) : "/onboarding");
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <ErrorBoundary>
        <Sidebar role="STUDENT" />
      </ErrorBoundary>
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <TopNav showAiBadge currentStreak={user.currentStreak} />
        <main className="flex-1 overflow-y-auto">
          <ErrorBoundary>{children}</ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
