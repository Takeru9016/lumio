import { generateObject } from "ai";
import { COURSE_CREATOR_ASSESSMENT_SYSTEM_PROMPT } from "@/lib/ai/prompts";
import { createExecutionTracker } from "@/lib/ai/runtime/execution";
import {
  createConversation,
  persistMessage,
  recordUsageEvent,
  startExecution,
} from "@/lib/ai/runtime/persistence";
import { assertActionAllowed } from "@/lib/ai/runtime/policy";
import { modelFor } from "@/lib/ai/runtime/provider";
import type { AIRequestContext } from "@/lib/ai/runtime/types";
import {
  buildAssessmentProposalSchema,
  MAX_ASSESSMENT_QUESTIONS,
  MIN_ASSESSMENT_QUESTIONS,
} from "@/lib/domain/course-creator/schema";
import type { AssessmentProposal } from "@/lib/domain/course-creator/types";

export type GenerateAssessmentParams = {
  lessonTitle: string;
  lessonContext: string;
  questionCount?: number;
};

export type AssessmentResult = {
  questions: AssessmentProposal["questions"];
  conversationId?: string;
  executionId?: string;
};

/** Generates an MCQ assessment proposal (AISurface.COURSE_CREATOR / GENERATE). Never writes Quiz/QuizQuestion itself. */
export async function generateAssessment(
  reqCtx: AIRequestContext,
  params: GenerateAssessmentParams
): Promise<AssessmentResult> {
  assertActionAllowed(reqCtx.surface, "GENERATE");

  const tenantId = reqCtx.auth.tenantId;
  if (!tenantId) {
    throw new Error("generateAssessment requires an authenticated tenant");
  }

  const questionCount = Math.min(
    MAX_ASSESSMENT_QUESTIONS,
    Math.max(MIN_ASSESSMENT_QUESTIONS, params.questionCount ?? MIN_ASSESSMENT_QUESTIONS)
  );

  const conversation = await createConversation(
    { tenantId, userId: reqCtx.auth.userId },
    {
      surface: reqCtx.surface,
      title: params.lessonTitle.slice(0, 120),
      contextMetadata: { stage: "assessment" },
    }
  );
  const { model, provider, modelId } = modelFor(reqCtx.surface);
  const execution = await startExecution(
    { tenantId, userId: reqCtx.auth.userId },
    {
      model: modelId,
      provider,
      operation: "course-creator.assessment",
      conversationId: conversation.id,
    }
  );
  const tracker = createExecutionTracker(execution.id, Date.now());

  await persistMessage(conversation.id, "user", params.lessonContext.slice(0, 4000));

  try {
    const schema = buildAssessmentProposalSchema(questionCount);
    const { object, usage } = await generateObject({
      model,
      schema,
      system: COURSE_CREATOR_ASSESSMENT_SYSTEM_PROMPT({
        lessonTitle: params.lessonTitle,
        lessonContext: params.lessonContext,
        questionCount,
      }),
      prompt: "Generate the assessment questions now.",
    });

    await persistMessage(conversation.id, "assistant", JSON.stringify(object).slice(0, 20000));
    await tracker.markSucceeded({
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
    });
    await recordUsageEvent(
      { tenantId, userId: reqCtx.auth.userId },
      {
        executionId: execution.id,
        operation: "course-creator.assessment",
        provider,
        model: modelId,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
      }
    );

    return {
      questions: object.questions,
      conversationId: conversation.id,
      executionId: execution.id,
    };
  } catch (err) {
    await tracker.markFailed(err);
    throw err;
  }
}
