import { z } from "zod";

// Bounds throughout this file exist for two reasons: keep the model call
// cheap/fast (curriculum-first, content-second — see docs/V2_AI_ARCHITECTURE.md,
// "Course Creator"), and stop a malformed/adversarial model response from
// producing an unbounded persistence payload downstream in saveDraft.ts.
export const MAX_SECTIONS = 12;
export const MAX_LESSONS_PER_SECTION = 15;
export const MAX_LEARNING_OBJECTIVES = 10;
export const MAX_SKILL_SUGGESTIONS = 10;
export const MAX_CITATIONS_PER_LESSON = 5;
export const MAX_KNOWLEDGE_DOCUMENT_IDS = 5;
export const MAX_TARGET_SKILL_IDS = 10;
export const MAX_ASSESSMENT_QUESTIONS = 10;
export const MIN_ASSESSMENT_QUESTIONS = 3;
export const MAX_LESSON_TEXT_CONTENT_CHARS = 20000;

export const courseCreatorInputSchema = z
  .object({
    goal: z.string().min(10).max(500),
    audience: z.string().max(300).optional(),
    difficulty: z.enum(["BEGINNER", "INTERMEDIATE", "ADVANCED"]).optional(),
    durationHours: z.number().min(1).max(200).optional(),
    targetSkillIds: z.array(z.string().min(1)).max(MAX_TARGET_SKILL_IDS).optional(),
    knowledgeDocumentIds: z.array(z.string().min(1)).max(MAX_KNOWLEDGE_DOCUMENT_IDS).optional(),
    assessmentStyle: z.enum(["MCQ", "NONE"]).default("MCQ"),
  })
  .strict();

const lessonProposalSchema = (maxCitationIndex: number) =>
  z.object({
    title: z.string().min(1).max(150),
    objective: z.string().min(1).max(300),
    estimatedMinutes: z.number().int().min(1).max(180),
    contentType: z.enum(["VIDEO", "TEXT", "QUIZ", "ASSIGNMENT"]),
    supportsSkillNames: z.array(z.string().min(1).max(120)).max(5).default([]),
    citationIndices: z
      .array(z.number().int().min(0))
      .max(MAX_CITATIONS_PER_LESSON)
      .default([])
      .refine((indices) => indices.every((i) => i <= maxCitationIndex), {
        message: "citationIndices must reference an index from the provided knowledge list",
      }),
  });

const sectionProposalSchema = (maxCitationIndex: number) =>
  z.object({
    title: z.string().min(1).max(150),
    description: z.string().min(1).max(500),
    lessons: z.array(lessonProposalSchema(maxCitationIndex)).min(1).max(MAX_LESSONS_PER_SECTION),
  });

/**
 * The curriculum proposal contract. `knowledgeCount` bounds `citationIndices`
 * to the actual number of Knowledge excerpts shown to the model for this
 * call — built per-invocation (see generate.ts) rather than as a static
 * export, since that count varies by request.
 */
export function buildCourseProposalSchema(knowledgeCount: number) {
  const maxCitationIndex = Math.max(0, knowledgeCount - 1);
  return z.object({
    title: z.string().min(1).max(200),
    description: z.string().min(100).max(2000),
    learningObjectives: z.array(z.string().min(1).max(300)).min(1).max(MAX_LEARNING_OBJECTIVES),
    targetSkillNames: z.array(z.string().min(1).max(120)).max(MAX_SKILL_SUGGESTIONS).default([]),
    estimatedDurationHours: z.number().min(1).max(200),
    sections: z.array(sectionProposalSchema(maxCitationIndex)).min(1).max(MAX_SECTIONS),
    assessmentStrategy: z.string().min(1).max(500),
  });
}

const contentBlockSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("heading"),
    level: z.union([z.literal(2), z.literal(3)]),
    text: z.string().min(1).max(200),
  }),
  z.object({ type: z.literal("paragraph"), text: z.string().min(1).max(2000) }),
  z.object({
    type: z.literal("list"),
    ordered: z.boolean(),
    items: z.array(z.string().min(1).max(300)).min(1).max(20),
  }),
  z.object({
    type: z.literal("code"),
    language: z.string().max(30).optional(),
    code: z.string().min(1).max(4000),
  }),
]);

export function buildLessonContentProposalSchema(knowledgeCount: number) {
  const maxCitationIndex = Math.max(0, knowledgeCount - 1);
  return z.object({
    blocks: z.array(contentBlockSchema).min(1).max(30),
    citationIndices: z
      .array(z.number().int().min(0))
      .max(MAX_CITATIONS_PER_LESSON)
      .default([])
      .refine((indices) => indices.every((i) => i <= maxCitationIndex), {
        message: "citationIndices must reference an index from the provided knowledge list",
      }),
  });
}
// Static shapes (knowledgeCount = 0) purely so a `z.infer` type exists to import;
// runtime validation always uses the build* function with the real count.
export const lessonContentProposalSchema = buildLessonContentProposalSchema(0);
export const courseProposalSchema = buildCourseProposalSchema(0);

const assessmentQuestionSchema = z
  .object({
    question: z.string().min(1).max(500),
    options: z
      .array(z.object({ id: z.string().min(1).max(10), text: z.string().min(1).max(300) }))
      .min(2)
      .max(6),
    correctAnswer: z.string().min(1).max(10),
    explanation: z.string().min(1).max(500),
    difficulty: z.enum(["EASY", "MEDIUM", "HARD"]),
    objectiveAlignment: z.string().min(1).max(300),
  })
  .refine((q) => q.options.some((o) => o.id === q.correctAnswer), {
    message: "correctAnswer must be the id of one of the provided options",
    path: ["correctAnswer"],
  });

export function buildAssessmentProposalSchema(questionCount: number) {
  return z.object({
    questions: z.array(assessmentQuestionSchema).length(questionCount),
  });
}
export const assessmentProposalSchema = buildAssessmentProposalSchema(MIN_ASSESSMENT_QUESTIONS);

/**
 * What the human save action accepts. `.strict()` rejects any unexpected key
 * outright — tenantId/userId/creatorId/courseId/publication-state fields are
 * simply not part of this shape, so a client that sends them gets a 400, not
 * a silently-ignored write. See saveDraft.ts for how the accepted fields are
 * still re-verified against the database rather than trusted as-is.
 */
const saveDraftAssessmentQuestionSchema = z
  .object({
    question: z.string().min(1).max(500),
    options: z
      .array(z.object({ id: z.string().min(1).max(10), text: z.string().min(1).max(300) }))
      .min(2)
      .max(6),
    correctAnswer: z.string().min(1).max(10),
    explanation: z.string().max(500).optional(),
  })
  .refine((q) => q.options.some((o) => o.id === q.correctAnswer), {
    message: "correctAnswer must be the id of one of the provided options",
    path: ["correctAnswer"],
  });

const saveDraftAssessmentSchema = z.object({
  title: z.string().min(1).max(150).default("Quiz"),
  passingScore: z.number().int().min(0).max(100).default(70),
  questions: z
    .array(saveDraftAssessmentQuestionSchema)
    .min(MIN_ASSESSMENT_QUESTIONS)
    .max(MAX_ASSESSMENT_QUESTIONS),
});

export const saveDraftInputSchema = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(2000),
    thumbnailUrl: z.string().max(2000).optional(),
    category: z.string().max(100).optional(),
    level: z.enum(["BEGINNER", "INTERMEDIATE", "ADVANCED"]).optional(),
    learningObjectives: z
      .array(z.string().min(1).max(300))
      .max(MAX_LEARNING_OBJECTIVES)
      .default([]),
    targetSkillIds: z.array(z.string().min(1)).max(MAX_TARGET_SKILL_IDS).default([]),
    sections: z
      .array(
        z.object({
          title: z.string().min(1).max(150),
          description: z.string().max(500).optional(),
          lessons: z
            .array(
              z.object({
                title: z.string().min(1).max(150),
                objective: z.string().max(300).optional(),
                contentType: z.enum(["VIDEO", "TEXT", "QUIZ", "ASSIGNMENT"]),
                textContent: z.string().max(MAX_LESSON_TEXT_CONTENT_CHARS).optional(),
                knowledgeDocumentId: z.string().min(1).optional(),
                assessment: saveDraftAssessmentSchema.optional(),
              })
            )
            .min(1)
            .max(MAX_LESSONS_PER_SECTION),
        })
      )
      .min(1)
      .max(MAX_SECTIONS),
  })
  .strict();
