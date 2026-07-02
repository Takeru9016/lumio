import { auth } from "@clerk/nextjs/server";
import type { UIMessage } from "ai";
import { redirect } from "next/navigation";

import { AiTutorChat } from "@/components";
import { db } from "@/lib/db";

export default async function AiTutorPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true },
  });
  if (!dbUser) redirect("/sign-in");

  // Standalone tutor is the lesson-less chat (lessonId is null).
  const aiChat = await db.aIChat.findFirst({
    where: { userId: dbUser.id, lessonId: null },
    select: { id: true, messages: true },
    orderBy: { updatedAt: "desc" },
  });
  const initialMessages = (aiChat?.messages as UIMessage[] | null) ?? [];

  return (
    <div className="p-6 max-w-3xl mx-auto h-full flex flex-col">
      <div className="mb-4 shrink-0">
        <h1
          className="text-xl font-bold text-text-primary"
          style={{ fontFamily: "var(--font-heading)" }}
        >
          AI Tutor
        </h1>
        <p className="text-sm text-text-muted">
          Ask general learning questions and think through concepts together.
        </p>
      </div>

      <div className="flex-1 min-h-0 rounded-lg border border-border bg-surface-1 px-4 shadow-sm">
        <AiTutorChat className="h-full" chatId={aiChat?.id} initialMessages={initialMessages} />
      </div>
    </div>
  );
}
