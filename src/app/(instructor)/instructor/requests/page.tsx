import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import { RequestsClient } from "@/components/instructor/RequestsClient";
import { db } from "@/lib/db";

export default async function InstructorRequestsPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true, role: true },
  });
  if (!dbUser || dbUser.role !== "INSTRUCTOR") redirect("/dashboard");

  const requests = await db.orgRequest.findMany({
    where: { requesterId: dbUser.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      type: true,
      payload: true,
      message: true,
      status: true,
      createdAt: true,
      resolvedAt: true,
    },
  });

  return (
    <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
      <div>
        <h1 className="text-xl font-semibold font-heading text-text-primary">Requests</h1>
        <p className="text-sm text-text-muted mt-1">
          Ask your organisation admin for seats, course capacity, or a new account.
        </p>
      </div>

      <RequestsClient
        initialRequests={requests.map((r) => ({
          ...r,
          createdAt: r.createdAt.toISOString(),
          resolvedAt: r.resolvedAt?.toISOString() ?? null,
        }))}
      />
    </div>
  );
}
