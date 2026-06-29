import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";

import { Sidebar, TopNav } from "@/components";

import { db, getRoleDashboard } from "@/lib";

export default async function StudentLayout({
  children,
}: {
  children: React.ReactNode;
}) {
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
      <Sidebar role="STUDENT" />
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <TopNav showAiBadge currentStreak={user.currentStreak} />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
