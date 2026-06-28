import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";

import { Sidebar, TopNav } from "@/components";

import { db, getRoleDashboard } from "@/lib";

export default async function OrgLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const user = await db.user.findUnique({
    where: { clerkId: userId },
    select: { role: true },
  });

  if (!user || user.role !== "ORG_ADMIN") {
    redirect(user ? getRoleDashboard(user.role) : "/onboarding");
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar role="ORG_ADMIN" />
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <TopNav />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
