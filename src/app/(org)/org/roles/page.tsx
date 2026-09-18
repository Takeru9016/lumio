import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { RolesClient } from "@/components";
import { db } from "@/lib/db";
import { listJobRoles } from "@/lib/domain/capability/roleManagement";
import { listActiveSkills } from "@/lib/domain/capability/skillListing";

export default async function OrgRolesPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true, tenantId: true, role: true, clerkId: true },
  });
  if (!dbUser || dbUser.role !== "ORG_ADMIN") redirect("/dashboard");
  if (!dbUser.tenantId) redirect("/onboarding");

  const ctx = {
    userId: dbUser.id,
    clerkId: dbUser.clerkId,
    tenantId: dbUser.tenantId,
    role: dbUser.role,
  };

  const [roles, skills] = await Promise.all([listJobRoles(ctx), listActiveSkills(ctx)]);

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
      <div>
        <h1 className="text-xl font-semibold font-heading text-text-primary">Capability roles</h1>
        <p className="text-sm text-text-muted mt-1">
          Define what each role in your organization needs, then assign it to your team.
        </p>
      </div>

      <Suspense fallback={null}>
        <RolesClient initialRoles={roles} initialSkills={skills} />
      </Suspense>
    </div>
  );
}
