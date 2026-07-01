import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import { Sidebar, TopNav } from "@/components";

import { db, getRoleDashboard } from "@/lib";

export default async function InstructorLayout({ children }: { children: React.ReactNode }) {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const user = await db.user.findUnique({
    where: { clerkId: userId },
    select: { role: true, currentStreak: true },
  });

  if (!user || user.role !== "INSTRUCTOR") {
    redirect(user ? getRoleDashboard(user.role) : "/onboarding");
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar role="INSTRUCTOR" />
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <TopNav currentStreak={user.currentStreak} />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
