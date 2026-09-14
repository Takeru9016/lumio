import { auth } from "@clerk/nextjs/server";
import { withAiGuards } from "@/lib/ai/middleware";
import { incrementAiUsage } from "@/lib/ai/quota";
import { db } from "@/lib/db";
import {
  AssessmentEvaluationError,
  evaluateAssignmentSubmission,
} from "@/lib/domain/assessment/evaluate";
import { assessmentRatelimit } from "@/lib/ratelimit";

/**
 * Phase 18 — AI-assisted grading draft. GENERATE-only, ephemeral: this route
 * never writes AssignmentSubmission/SkillEvidence/UserSkill/LearningEvent.
 * The existing PUT /api/assignments/[assignmentId]/submissions/[submissionId]/grade
 * route remains the only path that changes official grading state — this
 * route is purely additive, called BEFORE it, and its response is only ever
 * a suggestion the instructor may choose to copy into that route's own
 * request body.
 *
 * Authorization mirrors the grade route's existing sequence exactly (same
 * INSTRUCTOR/SUPER_ADMIN role gate, same course-instructorId ownership
 * check) — not re-derived, not widened or narrowed relative to who can
 * already grade this submission.
 *
 * Every identifier (assignmentId, submissionId) comes from the path only.
 * The request body is never read — there is nothing legitimate for a client
 * to supply here, so nothing is trusted from it.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ assignmentId: string; submissionId: string }> }
) {
  const { userId } = await auth();

  const guard = await withAiGuards(userId, assessmentRatelimit);
  if (!guard.ok) return guard.response;
  const { user } = guard;

  if (user.role !== "INSTRUCTOR" && user.role !== "SUPER_ADMIN") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const { assignmentId, submissionId } = await params;

  const assignment = await db.assignment.findUnique({
    where: { id: assignmentId },
    select: {
      title: true,
      description: true,
      maxScore: true,
      lesson: {
        select: {
          section: {
            select: { course: { select: { instructorId: true } } },
          },
        },
      },
    },
  });
  if (!assignment) return Response.json({ error: "Assignment not found" }, { status: 404 });
  if (assignment.lesson.section.course.instructorId !== user.id) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const submission = await db.assignmentSubmission.findFirst({
    where: { id: submissionId, assignmentId },
    select: { textContent: true, fileUrl: true },
  });
  if (!submission) return Response.json({ error: "Submission not found" }, { status: 404 });

  try {
    const draft = await evaluateAssignmentSubmission({
      auth: {
        userId: user.id,
        clerkId: userId as string,
        tenantId: user.tenantId,
        role: user.role,
      },
      assignmentTitle: assignment.title,
      assignmentDescriptionHtml: assignment.description,
      maxScore: assignment.maxScore,
      submissionTextHtml: submission.textContent,
      hasFileAttachment: submission.fileUrl !== null,
    });

    await incrementAiUsage(user.id);

    return Response.json(draft);
  } catch (err) {
    if (err instanceof AssessmentEvaluationError) {
      if (err.code === "NO_CONTENT") {
        return Response.json({ error: err.message }, { status: 422 });
      }
      console.error("[assessment] Grading-draft generation failed", err.code, err.cause ?? err);
      return Response.json(
        { error: "AI failed to generate a grading suggestion. Please try again." },
        { status: 502 }
      );
    }
    console.error("[assessment] Unexpected error generating grading draft", err);
    return Response.json({ error: "Failed to generate a grading suggestion" }, { status: 500 });
  }
}
