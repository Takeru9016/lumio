import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import { OrgRequestsClient } from "@/components/org/OrgRequestsClient";
import { db } from "@/lib/db";

export default async function OrgRequestsPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { role: true, tenantId: true },
  });
  if (!dbUser || dbUser.role !== "ORG_ADMIN") redirect("/dashboard");
  if (!dbUser.tenantId) redirect("/onboarding");

  const requests = await db.orgRequest.findMany({
    where: { tenantId: dbUser.tenantId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      type: true,
      payload: true,
      message: true,
      status: true,
      createdAt: true,
      resolvedAt: true,
      requester: { select: { name: true, email: true } },
    },
  });

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-6">
      <div>
        <h1 className="text-xl font-semibold font-heading text-text-primary">Requests</h1>
        <p className="text-sm text-text-muted mt-1">
          Seat, capacity, and account requests from your instructors.
        </p>
      </div>

      <OrgRequestsClient
        initialRequests={requests.map((r) => ({
          ...r,
          createdAt: r.createdAt.toISOString(),
          resolvedAt: r.resolvedAt?.toISOString() ?? null,
        }))}
      />
    </div>
  );
}
