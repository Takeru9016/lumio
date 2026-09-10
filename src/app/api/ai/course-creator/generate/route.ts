import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { withAiGuards } from "@/lib/ai/middleware";
import { incrementAiUsage } from "@/lib/ai/quota";
import { AIRuntimeError } from "@/lib/ai/runtime/types";
import { generateCourseProposal } from "@/lib/domain/course-creator/generate";
import { courseCreatorInputSchema } from "@/lib/domain/course-creator/schema";
import { quizRatelimit } from "@/lib/ratelimit";

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

  const parsed = courseCreatorInputSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const result = await generateCourseProposal(
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
    if (err instanceof z.ZodError) {
      return Response.json(
        { error: "AI generated an invalid proposal. Please try again." },
        { status: 502 }
      );
    }
    console.error("[course-creator] curriculum generation failed", err);
    return Response.json(
      { error: "AI failed to generate a curriculum proposal. Please try again." },
      { status: 502 }
    );
  }
}
