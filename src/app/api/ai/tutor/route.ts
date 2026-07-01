import { auth } from "@clerk/nextjs/server";
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  streamText,
  toUIMessageStream,
  type UIMessage,
} from "ai";
import type { Prisma } from "@/generated/prisma/client";
import { withAiGuards } from "@/lib/ai/middleware";
import { openai } from "@/lib/ai/openai";
import { TUTOR_SYSTEM_PROMPT } from "@/lib/ai/prompts";
import { incrementAiUsage } from "@/lib/ai/quota";
import { searchSimilarLessons } from "@/lib/ai/search";
import { db } from "@/lib/db";
import { tutorRatelimit } from "@/lib/ratelimit";

// Only the most recent turns are sent to the model; full history is persisted.
const MODEL_CONTEXT_WINDOW = 10;
const RAG_TOP_K = 3;

interface TutorRequestBody {
  messages: UIMessage[];
  lessonId?: string;
  courseId?: string;
  chatId?: string;
}

/**
 * Extracts the plain text of the most recent user message from its UIMessage
 * parts (v5+ messages carry text in `parts`, not `.content`).
 */
function lastUserMessageText(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user") continue;
    return message.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join(" ")
      .trim();
  }
  return "";
}

/**
 * Persists the full UIMessage[] to the user's AIChat for this lesson (or the
 * standalone chat when lessonId is absent). Ownership-scoped: a client-supplied
 * chatId can only update a row the user owns, otherwise a fresh chat is created.
 */
async function persistChat(
  dbUserId: string,
  lessonId: string | undefined,
  chatId: string | undefined,
  messages: UIMessage[],
): Promise<void> {
  const data = messages as unknown as Prisma.InputJsonValue;

  if (chatId) {
    const { count } = await db.aIChat.updateMany({
      where: { id: chatId, userId: dbUserId },
      data: { messages: data },
    });
    if (count > 0) return;
  }

  const existing = await db.aIChat.findFirst({
    where: { userId: dbUserId, lessonId: lessonId ?? null },
    select: { id: true },
  });

  if (existing) {
    await db.aIChat.update({
      where: { id: existing.id },
      data: { messages: data },
    });
    return;
  }

  await db.aIChat.create({
    data: { userId: dbUserId, lessonId: lessonId ?? null, messages: data },
  });
}

export async function POST(req: Request) {
  const { userId } = await auth();

  const guard = await withAiGuards(userId, tutorRatelimit);
  if (!guard.ok) return guard.response;
  const { user } = guard;

  let body: TutorRequestBody;
  try {
    body = (await req.json()) as TutorRequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { messages, lessonId, courseId, chatId } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return Response.json({ error: "messages is required" }, { status: 400 });
  }

  // Enrollment guard: a lesson-scoped chat may only pull RAG context from a
  // course the user is actually enrolled in. Standalone chats (no lessonId) skip
  // this entirely.
  if (lessonId) {
    const enrollment = await db.enrollment.findFirst({
      where: {
        userId: user.id,
        course: {
          sections: { some: { lessons: { some: { id: lessonId } } } },
        },
        status: { in: ["ACTIVE", "COMPLETED"] },
      },
    });
    if (!enrollment) {
      return new Response("Not enrolled in this course", { status: 403 });
    }
  }

  // RAG: only for lesson-scoped chats. The standalone tutor skips retrieval and
  // sends no context block rather than an empty one.
  let context: string | undefined;
  if (lessonId) {
    const query = lastUserMessageText(messages);
    if (query) {
      const similar = await searchSimilarLessons(query, courseId, RAG_TOP_K);
      if (similar.length > 0) {
        context = similar
          .map((l) => `## ${l.title}\n${l.textContent ?? ""}`.trim())
          .join("\n\n");
      }
    }
  }

  const result = streamText({
    model: openai("gpt-5.4-mini"),
    system: TUTOR_SYSTEM_PROMPT(context),
    messages: await convertToModelMessages(
      messages.slice(-MODEL_CONTEXT_WINDOW),
    ),
  });

  const stream = toUIMessageStream({
    stream: result.stream,
    originalMessages: messages,
    onEnd: async ({ messages: finalMessages }) => {
      // After the stream succeeds: persist history, then count the AI call.
      await persistChat(user.id, lessonId, chatId, finalMessages);
      await incrementAiUsage(user.id);
    },
  });

  return createUIMessageStreamResponse({ stream });
}
