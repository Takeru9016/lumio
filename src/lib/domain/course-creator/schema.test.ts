import { describe, expect, it } from "vitest";
import {
  buildAssessmentProposalSchema,
  buildCourseProposalSchema,
  buildLessonContentProposalSchema,
  courseCreatorInputSchema,
  MAX_SECTIONS,
  saveDraftInputSchema,
} from "@/lib/domain/course-creator/schema";

function validLesson(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    title: "Intro",
    objective: "Understand the basics",
    estimatedMinutes: 20,
    contentType: "TEXT",
    supportsSkillNames: [],
    citationIndices: [],
    ...overrides,
  };
}

function validSection(lessons = [validLesson()]) {
  return { title: "Section 1", description: "Overview", lessons };
}

function validProposal(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    title: "B2B Sales Fundamentals",
    description: "x".repeat(120),
    learningObjectives: ["Qualify a B2B lead"],
    targetSkillNames: [],
    estimatedDurationHours: 4,
    sections: [validSection()],
    assessmentStrategy: "One quiz per section",
    ...overrides,
  };
}

describe("courseCreatorInputSchema", () => {
  it("accepts a minimal valid input", () => {
    const result = courseCreatorInputSchema.safeParse({ goal: "Teach reps to qualify B2B leads" });
    expect(result.success).toBe(true);
  });

  it("rejects a goal that is too short", () => {
    expect(courseCreatorInputSchema.safeParse({ goal: "hi" }).success).toBe(false);
  });

  it("rejects unexpected top-level keys (e.g. a smuggled tenantId)", () => {
    const result = courseCreatorInputSchema.safeParse({
      goal: "Teach reps to qualify B2B leads",
      tenantId: "some-other-tenant",
    });
    expect(result.success).toBe(false);
  });

  it("bounds knowledgeDocumentIds and targetSkillIds arrays", () => {
    const tooMany = Array.from({ length: 50 }, (_, i) => `id-${i}`);
    expect(
      courseCreatorInputSchema.safeParse({
        goal: "Teach reps to qualify B2B leads",
        knowledgeDocumentIds: tooMany,
      }).success
    ).toBe(false);
    expect(
      courseCreatorInputSchema.safeParse({
        goal: "Teach reps to qualify B2B leads",
        targetSkillIds: tooMany,
      }).success
    ).toBe(false);
  });
});

describe("buildCourseProposalSchema — malformed/oversized model output rejected", () => {
  it("accepts a well-formed proposal", () => {
    const schema = buildCourseProposalSchema(0);
    expect(schema.safeParse(validProposal()).success).toBe(true);
  });

  it("rejects a description that is too short to ever clear the publish gate", () => {
    const schema = buildCourseProposalSchema(0);
    const result = schema.safeParse(validProposal({ description: "too short" }));
    expect(result.success).toBe(false);
  });

  it("rejects more sections than MAX_SECTIONS (oversized proposal)", () => {
    const schema = buildCourseProposalSchema(0);
    const tooManySections = Array.from({ length: MAX_SECTIONS + 1 }, () => validSection());
    expect(schema.safeParse(validProposal({ sections: tooManySections })).success).toBe(false);
  });

  it("rejects a lesson contentType outside the real LessonType enum", () => {
    const schema = buildCourseProposalSchema(0);
    const bad = validProposal({
      sections: [validSection([validLesson({ contentType: "INTERACTIVE_SIMULATION" })])],
    });
    expect(schema.safeParse(bad).success).toBe(false);
  });

  it("rejects a citationIndex outside the retrieved knowledge list (arbitrary/invented reference)", () => {
    // Only 2 knowledge items were retrieved (indices 0-1) for this call.
    const schema = buildCourseProposalSchema(2);
    const bad = validProposal({
      sections: [validSection([validLesson({ citationIndices: [5] })])],
    });
    expect(schema.safeParse(bad).success).toBe(false);
  });

  it("accepts a citationIndex within the retrieved knowledge list", () => {
    const schema = buildCourseProposalSchema(2);
    const ok = validProposal({
      sections: [validSection([validLesson({ citationIndices: [1] })])],
    });
    expect(schema.safeParse(ok).success).toBe(true);
  });

  it("rejects a proposal missing required fields (malformed model output)", () => {
    const schema = buildCourseProposalSchema(0);
    expect(schema.safeParse({ title: "only a title" }).success).toBe(false);
  });
});

describe("buildLessonContentProposalSchema", () => {
  it("rejects free-form HTML disguised as a paragraph block only insofar as bounds apply — but accepts structured blocks", () => {
    const schema = buildLessonContentProposalSchema(0);
    const ok = schema.safeParse({
      blocks: [{ type: "paragraph", text: "Plain text content." }],
      citationIndices: [],
    });
    expect(ok.success).toBe(true);
  });

  it("rejects an unknown block type", () => {
    const schema = buildLessonContentProposalSchema(0);
    const bad = schema.safeParse({
      blocks: [{ type: "iframe", src: "evil" }],
      citationIndices: [],
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a citationIndex beyond the retrieved knowledge count", () => {
    const schema = buildLessonContentProposalSchema(1);
    const bad = schema.safeParse({
      blocks: [{ type: "paragraph", text: "x" }],
      citationIndices: [9],
    });
    expect(bad.success).toBe(false);
  });
});

describe("buildAssessmentProposalSchema — correctAnswer must be a real option id", () => {
  it("accepts a question whose correctAnswer matches an option id", () => {
    const schema = buildAssessmentProposalSchema(1);
    const result = schema.safeParse({
      questions: [
        {
          question: "What is 2+2?",
          options: [
            { id: "a", text: "3" },
            { id: "b", text: "4" },
          ],
          correctAnswer: "b",
          explanation: "2+2=4",
          difficulty: "EASY",
          objectiveAlignment: "Arithmetic",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a correctAnswer that does not match any option id", () => {
    const schema = buildAssessmentProposalSchema(1);
    const result = schema.safeParse({
      questions: [
        {
          question: "What is 2+2?",
          options: [
            { id: "a", text: "3" },
            { id: "b", text: "4" },
          ],
          correctAnswer: "z",
          explanation: "2+2=4",
          difficulty: "EASY",
          objectiveAlignment: "Arithmetic",
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("saveDraftInputSchema — untrusted-input boundary", () => {
  const validInput = {
    title: "B2B Sales Fundamentals",
    description: "A course",
    learningObjectives: ["Qualify a lead"],
    targetSkillIds: [],
    sections: [{ title: "Section 1", lessons: [{ title: "Lesson 1", contentType: "TEXT" }] }],
  };

  it("accepts a well-formed draft input with no identity/ownership fields", () => {
    expect(saveDraftInputSchema.safeParse(validInput).success).toBe(true);
  });

  it("rejects a payload that smuggles tenantId", () => {
    expect(
      saveDraftInputSchema.safeParse({ ...validInput, tenantId: "attacker-tenant" }).success
    ).toBe(false);
  });

  it("rejects a payload that smuggles userId/creatorId", () => {
    expect(
      saveDraftInputSchema.safeParse({ ...validInput, creatorId: "someone-else" }).success
    ).toBe(false);
  });

  it("rejects a payload that smuggles a courseId (targeting an existing course)", () => {
    expect(
      saveDraftInputSchema.safeParse({ ...validInput, courseId: "existing-course-id" }).success
    ).toBe(false);
  });

  it("rejects a payload that smuggles a publication status", () => {
    expect(saveDraftInputSchema.safeParse({ ...validInput, status: "PUBLISHED" }).success).toBe(
      false
    );
  });
});
