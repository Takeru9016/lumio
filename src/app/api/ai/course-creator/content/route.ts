import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { withAiGuards } from "@/lib/ai/middleware";
import { incrementAiUsage } from "@/lib/ai/quota";
import { AIRuntimeError } from "@/lib/ai/runtime/types";
import { generateLessonContent } from "@/lib/domain/course-creator/content";
import { MAX_KNOWLEDGE_DOCUMENT_IDS } from "@/lib/domain/course-creator/schema";
import { quizRatelimit } from "@/lib/ratelimit";

const contentRequestSchema = z
  .object({
    courseGoal: z.string().min(1).max(500),
    lessonTitle: z.string().min(1).max(150),
    lessonObjective: z.string().max(300).optional(),
    knowledgeDocumentIds: z.array(z.string().min(1)).max(MAX_KNOWLEDGE_DOCUMENT_IDS).optional(),
  })
  .strict();

export async function POST(req: Request) {
  const { userId } = await auth();

  const guard = await withAiGuards(userId, quizRatelimit);
  if (!guard.ok) return guard.response;
  const { user } = guard;

  if (!user.tenantId) {
    return Response.json({ error: "AI Course Creator requires an organization" }, { status: 403 });
  }
  if (user.role !== "INSTRUCTOR") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = contentRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const result = await generateLessonContent(
      {
        auth: {
          userId: user.id,
          clerkId: userId as string,
          tenantId: user.tenantId,
          role: user.role,
        },
        surface: "COURSE_CREATOR",
      },
      parsed.data
    );
    await incrementAiUsage(user.id);
    return Response.json(result);
  } catch (err) {
    if (err instanceof AIRuntimeError && err.category === "POLICY_DENIED") {
      return Response.json({ error: "Not permitted" }, { status: 403 });
    }
    console.error("[course-creator] lesson content generation failed", err);
    return Response.json(
      { error: "AI failed to generate lesson content. Please try again." },
      { status: 502 }
    );
  }
}
