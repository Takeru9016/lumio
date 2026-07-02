import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import { AiBadge } from "@/components";
import { db } from "@/lib/db";
import { LearningPathClient } from "./LearningPathClient";

export default async function LearningPathPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { role: true },
  });
  if (!dbUser || dbUser.role !== "STUDENT") redirect("/dashboard");

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="mb-6 flex items-center gap-2">
        <h1
          className="text-xl font-bold text-text-primary"
          style={{ fontFamily: "var(--font-heading)" }}
        >
          Learning Path
        </h1>
        <AiBadge label="AI" size="md" />
      </div>

      <LearningPathClient />
    </div>
  );
}
