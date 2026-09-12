import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import { db } from "@/lib/db";
import { getOrganizationCapabilityReport } from "@/lib/domain/capability/organizationReport";
import { OrgCapabilityClient } from "./OrgCapabilityClient";

export default async function OrgCapabilityPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { role: true, tenantId: true },
  });
  if (!dbUser || dbUser.role !== "ORG_ADMIN") redirect("/dashboard");

  const initialPage = dbUser.tenantId
    ? await getOrganizationCapabilityReport(dbUser.tenantId)
    : { learners: [], nextCursor: null };

  return <OrgCapabilityClient initialPage={initialPage} />;
}
