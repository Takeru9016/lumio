import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { withAiGuards } from "@/lib/ai/middleware";
import { incrementAiUsage } from "@/lib/ai/quota";
import { AIRuntimeError } from "@/lib/ai/runtime/types";
import { generateAssessment } from "@/lib/domain/course-creator/assessment";
import {
  MAX_ASSESSMENT_QUESTIONS,
  MIN_ASSESSMENT_QUESTIONS,
} from "@/lib/domain/course-creator/schema";
import { quizRatelimit } from "@/lib/ratelimit";

const assessmentRequestSchema = z
  .object({
    lessonTitle: z.string().min(1).max(150),
    lessonContext: z.string().min(1).max(8000),
    questionCount: z
      .number()
      .int()
      .min(MIN_ASSESSMENT_QUESTIONS)
      .max(MAX_ASSESSMENT_QUESTIONS)
      .optional(),
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

  const parsed = assessmentRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const result = await generateAssessment(
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
    console.error("[course-creator] assessment generation failed", err);
    return Response.json(
      { error: "AI failed to generate an assessment. Please try again." },
      { status: 502 }
    );
  }
}
