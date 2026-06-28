import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getRoleDashboard } from "@/lib/role-redirect";

// Universal post-login landing page (NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=/dashboard).
// Looks up the user's role and immediately bounces to the correct role dashboard.
export default async function DashboardPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const user = await db.user.findUnique({
    where: { clerkId: userId },
    select: { role: true },
  });

  if (!user) redirect("/onboarding");

  redirect(getRoleDashboard(user.role));
}
