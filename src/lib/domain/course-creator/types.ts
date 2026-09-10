import type { z } from "zod";
import type {
  assessmentProposalSchema,
  courseCreatorInputSchema,
  courseProposalSchema,
  lessonContentProposalSchema,
  saveDraftInputSchema,
} from "@/lib/domain/course-creator/schema";

export type CourseCreatorInput = z.infer<typeof courseCreatorInputSchema>;
export type LessonContentProposal = z.infer<typeof lessonContentProposalSchema>;
export type AssessmentProposal = z.infer<typeof assessmentProposalSchema>;
export type SaveDraftInput = z.infer<typeof saveDraftInputSchema>;

/** One retrieved-and-authorized Knowledge excerpt as shown to the model and the reviewer. */
export type CourseCreatorKnowledgeItem = {
  chunkId: string;
  documentId: string;
  sourceId: string;
  content: string;
  score: number;
  citation: { documentTitle: string; sourceId: string };
};

export type CourseProposal = z.infer<typeof courseProposalSchema>;
export type SectionProposal = CourseProposal["sections"][number];
export type LessonProposal = SectionProposal["lessons"][number];

export type CourseProposalResult = {
  proposal: CourseProposal;
  knowledge: CourseCreatorKnowledgeItem[];
  conversationId?: string;
  executionId?: string;
};
