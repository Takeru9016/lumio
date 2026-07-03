import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";

import { db } from "@/lib/db";
import { getCompletionReport } from "@/lib/reports";

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { role: true, tenantId: true },
  });

  if (!dbUser || dbUser.role !== "ORG_ADMIN" || !dbUser.tenantId) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const teamId = searchParams.get("teamId") ?? undefined;
  const courseId = searchParams.get("courseId") ?? undefined;
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  const toDate = to ? new Date(to) : undefined;
  if (toDate) toDate.setUTCHours(23, 59, 59, 999);

  const rows = await getCompletionReport(dbUser.tenantId, {
    teamId,
    courseId,
    from: from ? new Date(from) : undefined,
    to: toDate,
  });

  return Response.json({ rows });
}
