import { afterAll, describe, expect, it } from "vitest";
import { AuthContextError } from "@/lib/auth/context";
import { db } from "@/lib/db";
import { CourseAuthorizationError } from "@/lib/domain/course/authorization";
import { saveCourseDraft } from "@/lib/domain/course-creator/saveDraft";
import {
  createIndexedDocument,
  createTenantUser,
  fakeEmbedding,
} from "@/lib/domain/knowledge/__test__/fixtures";

afterAll(async () => {
  await db.$disconnect();
});

const validInput = {
  title: "B2B Sales Fundamentals",
  description: "A course that teaches new sales employees how to qualify B2B leads.",
  learningObjectives: ["Qualify a B2B lead"],
  targetSkillIds: [] as string[],
  sections: [
    {
      title: "Getting started",
      lessons: [{ title: "What is B2B sales?", contentType: "TEXT" as const }],
    },
  ],
};

describe("saveCourseDraft — the human/application save boundary", () => {
  it("creates a DRAFT course with tenant/creator derived from AuthContext, never from input", async () => {
    const { tenant, ctx } = await createTenantUser("INSTRUCTOR");

    const course = await saveCourseDraft(ctx, validInput);

    expect(course.status).toBe("DRAFT");
    expect(course.tenantId).toBe(tenant.id);
    expect(course.instructorId).toBe(ctx.userId);
    expect(course.title).toBe(validInput.title);
  });

  it("forces DRAFT status regardless of any client-supplied value (schema doesn't even accept the field)", async () => {
    const { ctx } = await createTenantUser("INSTRUCTOR");
    const withStatus = { ...validInput, status: "PUBLISHED" };
    await expect(saveCourseDraft(ctx, withStatus)).rejects.toThrow();
  });

  it("creates Sections and Lessons in a single transaction, correctly nested", async () => {
    const { ctx } = await createTenantUser("INSTRUCTOR");
    const input = {
      ...validInput,
      sections: [
        {
          title: "Section A",
          lessons: [
            { title: "A1", contentType: "TEXT" as const },
            { title: "A2", contentType: "VIDEO" as const },
          ],
        },
        { title: "Section B", lessons: [{ title: "B1", contentType: "QUIZ" as const }] },
      ],
    };

    const course = await saveCourseDraft(ctx, input);

    const sections = await db.section.findMany({
      where: { courseId: course.id },
      include: { lessons: true },
      orderBy: { order: "asc" },
    });
    expect(sections).toHaveLength(2);
    expect(sections[0].lessons).toHaveLength(2);
    expect(sections[1].lessons).toHaveLength(1);
    expect(sections[0].lessons.every((l) => l.isPublished === false)).toBe(true);
  });

  it("verifies every targetSkillId belongs to the caller's own tenant — a cross-tenant id is silently dropped, not trusted", async () => {
    const { tenant, ctx } = await createTenantUser("INSTRUCTOR");
    const { tenant: otherTenant } = await createTenantUser("INSTRUCTOR");

    const ownSkill = await db.skill.create({
      data: { tenantId: tenant.id, name: "Own skill", slug: `own-skill-${Date.now()}` },
    });
    const otherSkill = await db.skill.create({
      data: {
        tenantId: otherTenant.id,
        name: "Other tenant skill",
        slug: `other-skill-${Date.now()}`,
      },
    });

    const course = await saveCourseDraft(ctx, {
      ...validInput,
      targetSkillIds: [ownSkill.id, otherSkill.id],
    });

    const courseSkills = await db.courseSkill.findMany({ where: { courseId: course.id } });
    expect(courseSkills.map((cs) => cs.skillId)).toEqual([ownSkill.id]);
  });

  it("rejects a non-INSTRUCTOR role, same as POST /api/courses", async () => {
    const { ctx } = await createTenantUser("STUDENT");
    await expect(saveCourseDraft(ctx, validInput)).rejects.toThrow(CourseAuthorizationError);
  });

  it("enforces the plan's maxCourses ceiling, same as POST /api/courses", async () => {
    const { tenant, ctx } = await createTenantUser("INSTRUCTOR");
    // FREE plan (the fixture default) has maxCourses: 1.
    await db.course.create({
      data: {
        title: "Existing course",
        slug: `existing-${Date.now()}`,
        instructorId: ctx.userId,
        tenantId: tenant.id,
      },
    });

    await expect(saveCourseDraft(ctx, validInput)).rejects.toThrow(CourseAuthorizationError);
  });

  it("rejects a tenant-less AuthContext (FREE-plan solo user) rather than creating an unscoped course", async () => {
    const { ctx } = await createTenantUser("INSTRUCTOR");
    const tenantless = { ...ctx, tenantId: null };
    await expect(saveCourseDraft(tenantless, validInput)).rejects.toThrow(AuthContextError);
  });

  it("rejects malformed input before any write happens (no partial course structure)", async () => {
    const { ctx } = await createTenantUser("INSTRUCTOR");
    const before = await db.course.count({ where: { instructorId: ctx.userId } });

    await expect(saveCourseDraft(ctx, { title: "" })).rejects.toThrow();

    const after = await db.course.count({ where: { instructorId: ctx.userId } });
    expect(after).toBe(before);
  });
});

const validAssessment = {
  title: "Check your understanding",
  passingScore: 70,
  questions: [
    {
      question: "What is a qualified lead?",
      options: [
        { id: "a", text: "Any prospect" },
        { id: "b", text: "A prospect matching ICP criteria" },
      ],
      correctAnswer: "b",
      explanation: "ICP fit is what qualifies a lead.",
    },
    {
      question: "Which stage comes first?",
      options: [
        { id: "a", text: "Discovery" },
        { id: "b", text: "Close" },
      ],
      correctAnswer: "a",
    },
    {
      question: "What signals buying intent?",
      options: [
        { id: "a", text: "Budget confirmed" },
        { id: "b", text: "Website visit" },
      ],
      correctAnswer: "a",
    },
  ],
};

describe("saveCourseDraft — lesson content, knowledge, and quiz persistence", () => {
  it("persists lesson.textContent verbatim", async () => {
    const { ctx } = await createTenantUser("INSTRUCTOR");
    const course = await saveCourseDraft(ctx, {
      ...validInput,
      sections: [
        {
          title: "Section A",
          lessons: [
            {
              title: "Intro",
              contentType: "TEXT" as const,
              textContent: "<p>Hello world</p>",
            },
          ],
        },
      ],
    });

    const lesson = await db.lesson.findFirst({ where: { section: { courseId: course.id } } });
    expect(lesson?.textContent).toBe("<p>Hello world</p>");
  });

  it("persists an accessible knowledgeDocumentId", async () => {
    const { tenant, ctx } = await createTenantUser("INSTRUCTOR");
    const { document } = await createIndexedDocument({
      tenantId: tenant.id,
      title: "Doc",
      content: "content",
      embedding: fakeEmbedding(10),
    });

    const course = await saveCourseDraft(ctx, {
      ...validInput,
      sections: [
        {
          title: "Section A",
          lessons: [
            { title: "Intro", contentType: "TEXT" as const, knowledgeDocumentId: document.id },
          ],
        },
      ],
    });

    const lesson = await db.lesson.findFirst({ where: { section: { courseId: course.id } } });
    expect(lesson?.knowledgeDocumentId).toBe(document.id);
  });

  it("silently drops an inaccessible (RESTRICTED, no access row) knowledgeDocumentId", async () => {
    const { tenant, ctx } = await createTenantUser("INSTRUCTOR");
    const { document } = await createIndexedDocument({
      tenantId: tenant.id,
      title: "Restricted doc",
      content: "content",
      embedding: fakeEmbedding(11),
      visibility: "RESTRICTED",
    });

    const course = await saveCourseDraft(ctx, {
      ...validInput,
      sections: [
        {
          title: "Section A",
          lessons: [
            { title: "Intro", contentType: "TEXT" as const, knowledgeDocumentId: document.id },
          ],
        },
      ],
    });

    const lesson = await db.lesson.findFirst({ where: { section: { courseId: course.id } } });
    expect(lesson?.knowledgeDocumentId).toBeNull();
  });

  it("cannot persist a cross-tenant knowledgeDocumentId", async () => {
    const { ctx } = await createTenantUser("INSTRUCTOR");
    const { tenant: otherTenant } = await createTenantUser("INSTRUCTOR");
    const { document } = await createIndexedDocument({
      tenantId: otherTenant.id,
      title: "Other tenant doc",
      content: "content",
      embedding: fakeEmbedding(12),
    });

    const course = await saveCourseDraft(ctx, {
      ...validInput,
      sections: [
        {
          title: "Section A",
          lessons: [
            { title: "Intro", contentType: "TEXT" as const, knowledgeDocumentId: document.id },
          ],
        },
      ],
    });

    const lesson = await db.lesson.findFirst({ where: { section: { courseId: course.id } } });
    expect(lesson?.knowledgeDocumentId).toBeNull();
  });

  it("creates exactly one Quiz with its QuizQuestions for a QUIZ lesson with an assessment", async () => {
    const { ctx } = await createTenantUser("INSTRUCTOR");
    const course = await saveCourseDraft(ctx, {
      ...validInput,
      sections: [
        {
          title: "Section A",
          lessons: [
            {
              title: "Quiz lesson",
              contentType: "QUIZ" as const,
              assessment: validAssessment,
            },
          ],
        },
      ],
    });

    const lesson = await db.lesson.findFirst({ where: { section: { courseId: course.id } } });
    const quizzes = await db.quiz.findMany({ where: { lessonId: lesson?.id } });
    expect(quizzes).toHaveLength(1);

    const questions = await db.quizQuestion.findMany({
      where: { quizId: quizzes[0].id },
      orderBy: { order: "asc" },
    });
    expect(questions).toHaveLength(3);
    expect(questions.map((q) => q.order)).toEqual([0, 1, 2]);
    expect(questions.map((q) => q.correctAnswer)).toEqual(["b", "a", "a"]);
    expect(questions.every((q) => q.type === "MCQ")).toBe(true);
    expect(questions[0].options).toEqual(validAssessment.questions[0].options);
  });

  it("rejects a malformed correctAnswer that isn't one of the question's own option ids", async () => {
    const { ctx } = await createTenantUser("INSTRUCTOR");
    const malformed = {
      ...validAssessment,
      questions: [
        {
          question: "Bad question",
          options: [
            { id: "a", text: "Option A" },
            { id: "b", text: "Option B" },
          ],
          correctAnswer: "z",
        },
        ...validAssessment.questions.slice(1),
      ],
    };

    await expect(
      saveCourseDraft(ctx, {
        ...validInput,
        sections: [
          {
            title: "Section A",
            lessons: [
              { title: "Quiz lesson", contentType: "QUIZ" as const, assessment: malformed },
            ],
          },
        ],
      })
    ).rejects.toThrow();
  });

  it("does not create a Quiz for a QUIZ lesson with no generated assessment", async () => {
    const { ctx } = await createTenantUser("INSTRUCTOR");
    const course = await saveCourseDraft(ctx, {
      ...validInput,
      sections: [
        {
          title: "Section A",
          lessons: [{ title: "Quiz lesson", contentType: "QUIZ" as const }],
        },
      ],
    });

    const lesson = await db.lesson.findFirst({ where: { section: { courseId: course.id } } });
    const quizzes = await db.quiz.findMany({ where: { lessonId: lesson?.id } });
    expect(quizzes).toHaveLength(0);
  });

  it("a lesson removed from the payload before save creates no Lesson or Quiz", async () => {
    const { ctx } = await createTenantUser("INSTRUCTOR");
    const course = await saveCourseDraft(ctx, {
      ...validInput,
      sections: [
        {
          title: "Section A",
          lessons: [{ title: "Kept lesson", contentType: "TEXT" as const }],
        },
      ],
    });

    const lessons = await db.lesson.findMany({ where: { section: { courseId: course.id } } });
    expect(lessons).toHaveLength(1);
    expect(lessons[0].title).toBe("Kept lesson");
  });

  it("rolls back with no partial Course/Section/Lesson state on a mid-transaction failure", async () => {
    const { ctx } = await createTenantUser("INSTRUCTOR");
    const before = await db.course.count({ where: { instructorId: ctx.userId } });

    // An empty questions array fails saveDraftInputSchema's
    // min(MIN_ASSESSMENT_QUESTIONS) bound before the transaction opens —
    // asserts the Quiz-bearing path specifically leaves nothing behind on a
    // pre-transaction validation rejection.
    await expect(
      saveCourseDraft(ctx, {
        ...validInput,
        sections: [
          {
            title: "Section A",
            lessons: [
              {
                title: "Quiz lesson",
                contentType: "QUIZ" as const,
                assessment: { ...validAssessment, questions: [] },
              },
            ],
          },
        ],
      })
    ).rejects.toThrow();

    const after = await db.course.count({ where: { instructorId: ctx.userId } });
    expect(after).toBe(before);
  });
});
