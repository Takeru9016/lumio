import { z } from "zod";

export const MAX_FEEDBACK_LENGTH = 2000;
export const MAX_RATIONALE_LENGTH = 1000;

/**
 * The AI grading-draft output contract (Phase 18 locked contract). Built
 * per-invocation with the assignment's real `maxScore` (server-authoritative,
 * never client- or model-supplied) as the schema's own upper bound — the
 * same per-call schema-builder pattern `buildCourseProposalSchema(knowledgeCount)`
 * already established. `.strict()` rejects any field the model might
 * hallucinate beyond these three.
 */
export function buildAssessmentDraftSchema(maxScore: number) {
  return z
    .object({
      suggestedScore: z.number().int().min(0).max(maxScore),
      feedback: z.string().trim().min(1).max(MAX_FEEDBACK_LENGTH),
      rationale: z.string().trim().min(1).max(MAX_RATIONALE_LENGTH),
    })
    .strict();
}

export type AssessmentDraft = z.infer<ReturnType<typeof buildAssessmentDraftSchema>>;
