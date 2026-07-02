import { auth } from "@clerk/nextjs/server";
import { generateText } from "ai";

import { withAiGuards } from "@/lib/ai/middleware";
import { openai } from "@/lib/ai/openai";
import { SUMMARY_SYSTEM_PROMPT } from "@/lib/ai/prompts";
import { incrementAiUsage } from "@/lib/ai/quota";
import { db } from "@/lib/db";
import { summaryRatelimit } from "@/lib/ratelimit";

interface SummaryRequestBody {
  lessonId?: string;
}

/** Strips Tiptap HTML down to plain prose for the model prompt. */
function htmlToText(html: string | null): string {
  if (!html) return "";
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export async function POST(req: Request) {
  const { userId } = await auth();

  const guard = await withAiGuards(userId, summaryRatelimit);
  if (!guard.ok) return guard.response;
  const { user } = guard;

  let body: SummaryRequestBody;
  try {
    body = (await req.json()) as SummaryRequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { lessonId } = body;
  if (!lessonId) {
    return Response.json({ error: "lessonId is required" }, { status: 400 });
  }

  const lesson = await db.lesson.findFirst({
    where: { id: lessonId },
    select: {
      id: true,
      title: true,
      description: true,
      textContent: true,
      type: true,
      isFree: true,
      aiSummary: true,
      section: { select: { courseId: true } },
    },
  });

  if (!lesson) {
    return Response.json({ error: "Lesson not found" }, { status: 404 });
  }

  if (!lesson.isFree) {
    const enrollment = await db.enrollment.findFirst({
      where: {
        userId: user.id,
        courseId: lesson.section.courseId,
        status: { in: ["ACTIVE", "COMPLETED"] },
      },
    });
    if (!enrollment) {
      return Response.json({ error: "Not enrolled in this course" }, { status: 403 });
    }
  }

  // Cached — never call the LLM twice for the same lesson.
  if (lesson.aiSummary) {
    return Response.json({ summary: lesson.aiSummary });
  }

  const bodyText = htmlToText(lesson.textContent);
  const content = [
    lesson.title,
    lesson.description,
    bodyText ||
      `(This is a ${lesson.type.toLowerCase()} lesson with no written transcript ` +
        "available. Base the summary on the title and description alone.)",
  ]
    .filter(Boolean)
    .join("\n\n")
    .trim();

  let summary: string;
  try {
    const { text } = await generateText({
      model: openai("gpt-5.4-mini"),
      system: SUMMARY_SYSTEM_PROMPT(content),
      prompt:
        "Summarise this lesson in exactly 3 concise bullet points. " +
        "Each bullet: one clear takeaway a student should remember. " +
        "Return ONLY the 3 bullets, no preamble.",
    });
    summary = text.trim();
  } catch {
    return Response.json(
      { error: "AI failed to generate a summary. Please try again." },
      { status: 502 }
    );
  }

  await db.lesson.update({ where: { id: lesson.id }, data: { aiSummary: summary } });
  await incrementAiUsage(user.id);

  return Response.json({ summary });
}
