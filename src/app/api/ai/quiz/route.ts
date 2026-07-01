import { auth } from "@clerk/nextjs/server";
import { generateObject } from "ai";
import { z } from "zod";

import { withAiGuards } from "@/lib/ai/middleware";
import { openai } from "@/lib/ai/openai";
import { QUIZ_SYSTEM_PROMPT } from "@/lib/ai/prompts";
import { incrementAiUsage } from "@/lib/ai/quota";
import { db } from "@/lib/db";
import { quizRatelimit } from "@/lib/ratelimit";

// Source content is truncated before hitting the model to stay within token
// budget; lesson bodies past this length are diminishing returns for 5 questions.
const MAX_CONTENT_CHARS = 8000;
// Below this, there isn't enough grounded material to write answerable questions.
const MIN_CONTENT_CHARS = 40;

const quizSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string(),
        type: z.enum(["MCQ", "TRUE_FALSE"]),
        options: z
          .array(z.object({ id: z.string(), text: z.string() }))
          .optional(),
        correctAnswer: z.string(),
        explanation: z.string(),
      }),
    )
    .length(5),
});

interface QuizRequestBody {
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

  // Rate limit + monthly quota ceiling. Instructors are quota-gated too.
  const guard = await withAiGuards(userId, quizRatelimit);
  if (!guard.ok) return guard.response;
  const { user } = guard;

  let body: QuizRequestBody;
  try {
    body = (await req.json()) as QuizRequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { lessonId } = body;
  if (!lessonId) {
    return Response.json({ error: "lessonId is required" }, { status: 400 });
  }

  // Ownership guard: the requester must be the instructor who owns the course
  // this lesson belongs to.
  const lesson = await db.lesson.findFirst({
    where: { id: lessonId },
    select: {
      id: true,
      title: true,
      description: true,
      textContent: true,
      section: {
        select: { course: { select: { instructorId: true } } },
      },
    },
  });

  if (!lesson) {
    return Response.json({ error: "Lesson not found" }, { status: 404 });
  }
  if (lesson.section.course.instructorId !== user.id) {
    return Response.json(
      { error: "You do not own this course" },
      { status: 403 },
    );
  }

  // Build the grounding content. A Mux transcript would go here too, but no
  // transcript field is stored on Lesson yet, so we ground on the written body.
  const content = [
    lesson.title,
    lesson.description,
    htmlToText(lesson.textContent),
  ]
    .filter(Boolean)
    .join("\n\n")
    .trim()
    .slice(0, MAX_CONTENT_CHARS);

  if (content.length < MIN_CONTENT_CHARS) {
    return Response.json(
      {
        error:
          "Not enough lesson content to generate a quiz. Add lesson text first.",
      },
      { status: 422 },
    );
  }

  let questions: z.infer<typeof quizSchema>["questions"];
  try {
    const { object } = await generateObject({
      model: openai("gpt-5.4"),
      schema: quizSchema,
      system: QUIZ_SYSTEM_PROMPT(content),
      prompt: "Generate the 5 quiz questions for this lesson now.",
    });
    questions = object.questions;
  } catch {
    return Response.json(
      { error: "AI failed to generate a quiz. Please try again." },
      { status: 502 },
    );
  }

  // Count the AI call only after a successful generation.
  await incrementAiUsage(user.id);

  // Preview-only: nothing is persisted here. The instructor reviews (and may
  // edit) the questions, then "Approve & Save" writes them via the lesson quiz
  // endpoint with isAiGenerated: true.
  return Response.json({ questions });
}
