import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import { db } from "@/lib/db";
import { getInstructorCapabilityReport } from "@/lib/domain/capability/instructorReport";
import { InstructorCapabilityClient } from "./InstructorCapabilityClient";

export default async function InstructorCapabilityPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true, role: true, tenantId: true },
  });
  if (!dbUser || dbUser.role !== "INSTRUCTOR") redirect("/dashboard");

  const initialPage = dbUser.tenantId
    ? await getInstructorCapabilityReport(dbUser.id, dbUser.tenantId)
    : { learners: [], nextCursor: null };

  return <InstructorCapabilityClient initialPage={initialPage} />;
}
