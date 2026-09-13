import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import { db } from "@/lib/db";
import { listManageableKnowledgeDocuments } from "@/lib/domain/knowledge/management";
import { OrgKnowledgeClient } from "./OrgKnowledgeClient";

export default async function OrgKnowledgePage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true, role: true, tenantId: true },
  });
  if (!dbUser || dbUser.role !== "ORG_ADMIN") redirect("/dashboard");

  const initialDocuments = dbUser.tenantId
    ? await listManageableKnowledgeDocuments({
        userId: dbUser.id,
        clerkId: userId,
        tenantId: dbUser.tenantId,
        role: dbUser.role,
      })
    : [];

  return <OrgKnowledgeClient initialDocuments={initialDocuments} />;
}
