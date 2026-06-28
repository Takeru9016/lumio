import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getRoleDashboard } from "@/lib/role-redirect";
import { TopNav } from "@/components/layout/TopNav";
import { Sidebar } from "@/components/layout/Sidebar";

export default async function StudentLayout({
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

  if (!user || user.role !== "STUDENT") {
    redirect(user ? getRoleDashboard(user.role) : "/onboarding");
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar role="STUDENT" />
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <TopNav showAiBadge />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
