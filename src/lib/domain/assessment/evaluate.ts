import { generateObject } from "ai";
import { AI_ASSESSMENT_SYSTEM_PROMPT } from "@/lib/ai/prompts";
import { buildAIContext } from "@/lib/ai/runtime/context";
import { createExecutionTracker } from "@/lib/ai/runtime/execution";
import { recordUsageEvent, startExecution } from "@/lib/ai/runtime/persistence";
import { assertActionAllowed } from "@/lib/ai/runtime/policy";
import { modelFor } from "@/lib/ai/runtime/provider";
import type { AIRequestContext } from "@/lib/ai/runtime/types";
import { buildAssessmentDraftSchema } from "@/lib/domain/assessment/schema";

const MAX_CONTENT_CHARS_PER_ITEM = 1200;
const MAX_QUERY_CHARS = 500;
const KNOWLEDGE_TOP_K = 5;

export type AssessmentEvaluationErrorCode = "NO_CONTENT" | "INVALID_OUTPUT" | "PROVIDER_FAILURE";

export class AssessmentEvaluationError extends Error {
  constructor(
    public code: AssessmentEvaluationErrorCode,
    message: string,
    public cause?: unknown
  ) {
    super(message);
    this.name = "AssessmentEvaluationError";
  }
}

/** Strips Tiptap HTML down to plain prose for the model prompt (same shape as /api/ai/summary's htmlToText). */
function htmlToText(html: string | null): string {
  if (!html) return "";
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export type AssessmentEvaluationInput = {
  /** The requesting instructor's own resolved auth context — never the student's. */
  auth: AIRequestContext["auth"];
  assignmentTitle: string;
  /** Raw Tiptap HTML, stripped internally — callers never pre-strip. */
  assignmentDescriptionHtml: string;
  maxScore: number;
  /** Raw Tiptap HTML or null, stripped internally. */
  submissionTextHtml: string | null;
  /** Existence only — the file itself is never fetched or sent to the model. */
  hasFileAttachment: boolean;
};

export type AssessmentEvaluationResult = {
  suggestedScore: number;
  feedback: string;
  rationale: string;
  citations: string[];
};

/**
 * Phase 18 — produces an ephemeral grading draft (never persisted, never
 * written to AssignmentSubmission/SkillEvidence/UserSkill/LearningEvent).
 * GENERATE-only (ASSESSMENT surface: READ+GENERATE, WRITE=false,
 * EXECUTE=false) — this function never calls a WRITE or EXECUTE action, and
 * never invokes a tool. The instructor's existing grade route remains the
 * only path that can change official grading state; nothing here calls it.
 */
export async function evaluateAssignmentSubmission(
  input: AssessmentEvaluationInput
): Promise<AssessmentEvaluationResult> {
  assertActionAllowed("ASSESSMENT", "READ");
  assertActionAllowed("ASSESSMENT", "GENERATE");

  const assignmentInstructions = htmlToText(input.assignmentDescriptionHtml);
  const submissionText = htmlToText(input.submissionTextHtml);
  const hasSubmissionText = submissionText.length > 0;

  if (!hasSubmissionText && !input.hasFileAttachment) {
    throw new AssessmentEvaluationError(
      "NO_CONTENT",
      "This submission has no text or file content to evaluate"
    );
  }

  const reqCtx: AIRequestContext = { auth: input.auth, surface: "ASSESSMENT" };

  // Query construction is deliberately the assignment's own title +
  // instructions, never the student's submission text — a stable,
  // non-adversarial retrieval query (see Phase 18 contract, "Knowledge
  // Context"). buildAIContext already skips retrieval entirely when
  // tenantId is null and degrades to [] on any retrieval failure — no
  // separate tenant/try-catch handling is needed here.
  const query = `${input.assignmentTitle} ${assignmentInstructions}`.slice(0, MAX_QUERY_CHARS);
  const aiContext = await buildAIContext(reqCtx, { query, topK: KNOWLEDGE_TOP_K });
  const knowledge = aiContext.knowledge;
  const knowledgeExcerpts = knowledge.map((k) => k.content.slice(0, MAX_CONTENT_CHARS_PER_ITEM));
  // Distinct source titles from every chunk actually retrieved and shown to
  // the model — never parsed from the model's generated text, so a
  // hallucinated reference can never become a fake citation (same guarantee
  // AI Search's dedupeCitationsByDocument already provides).
  const citations = [...new Set(knowledge.map((k) => k.citation.documentTitle))];

  const { model, provider, modelId } = modelFor("ASSESSMENT");

  // AIExecution/AIUsageEvent require a tenant (PersistenceScope.tenantId is
  // non-nullable) — a FREE-plan instructor with no tenant still gets an
  // evaluation, just without V2 runtime bookkeeping, mirroring how Knowledge
  // retrieval itself already degrades for the same tenant-less case.
  let executionId: string | undefined;
  const startedAt = Date.now();
  if (input.auth.tenantId) {
    try {
      const execution = await startExecution(
        { tenantId: input.auth.tenantId, userId: input.auth.userId },
        { model: modelId, provider, operation: "assessment.suggest-grade" }
      );
      executionId = execution.id;
    } catch (err) {
      console.error("[ai-runtime] Failed to start assessment AIExecution", err);
      executionId = undefined;
    }
  }
  const tracker = createExecutionTracker(executionId, startedAt);

  try {
    const schema = buildAssessmentDraftSchema(input.maxScore);
    const { object, usage } = await generateObject({
      model,
      schema,
      system: AI_ASSESSMENT_SYSTEM_PROMPT({
        assignmentTitle: input.assignmentTitle,
        assignmentInstructions,
        maxScore: input.maxScore,
        knowledgeExcerpts,
        hasFileAttachment: input.hasFileAttachment,
        hasSubmissionText,
      }),
      prompt: hasSubmissionText
        ? `Student submission:\n${submissionText}`
        : "The student submitted only a file attachment (not evaluated) and no text.",
    });

    // Defense-in-depth (Phase 18 contract §22): re-checked explicitly even
    // though the schema above already bounds this — never trust structured
    // output alone for the one field that gates evidence creation downstream.
    if (
      !Number.isInteger(object.suggestedScore) ||
      object.suggestedScore < 0 ||
      object.suggestedScore > input.maxScore
    ) {
      throw new AssessmentEvaluationError("INVALID_OUTPUT", "AI returned an out-of-contract score");
    }

    await tracker.markSucceeded({
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
    });

    if (executionId && input.auth.tenantId) {
      try {
        await recordUsageEvent(
          { tenantId: input.auth.tenantId, userId: input.auth.userId },
          {
            executionId,
            operation: "assessment.suggest-grade",
            provider,
            model: modelId,
            inputTokens: usage?.inputTokens,
            outputTokens: usage?.outputTokens,
          }
        );
      } catch (err) {
        console.error("[ai-runtime] Failed to record assessment AIUsageEvent", err);
      }
    }

    return {
      suggestedScore: object.suggestedScore,
      feedback: object.feedback,
      rationale: object.rationale,
      citations,
    };
  } catch (err) {
    await tracker.markFailed(err);
    if (err instanceof AssessmentEvaluationError) throw err;
    throw new AssessmentEvaluationError(
      "PROVIDER_FAILURE",
      "AI failed to generate a grading suggestion",
      err
    );
  }
}
