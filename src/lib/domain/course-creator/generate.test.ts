import { afterAll, describe, expect, it, vi } from "vitest";
import type { AIRequestContext } from "@/lib/ai/runtime/types";
import { AIRuntimeError } from "@/lib/ai/runtime/types";
import { db } from "@/lib/db";
import {
  createIndexedDocument,
  createTenantUser,
  fakeEmbedding,
} from "@/lib/domain/knowledge/__test__/fixtures";

const QUERY_VECTOR = fakeEmbedding(9001);

vi.mock("@/lib/ai/embeddings", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/embeddings")>("@/lib/ai/embeddings");
  return { ...actual, generateEmbedding: vi.fn().mockResolvedValue(QUERY_VECTOR) };
});

// A minimal valid CourseProposal the mocked model "returns" — every test that
// needs a specific citationIndices shape overrides `sections` per-call via
// the mock's implementation below.
function fakeProposal(citationIndices: number[] = []) {
  return {
    title: "Generated Course",
    description: "x".repeat(120),
    learningObjectives: ["Objective 1"],
    targetSkillNames: [],
    estimatedDurationHours: 4,
    sections: [
      {
        title: "Section 1",
        description: "desc",
        lessons: [
          {
            title: "Lesson 1",
            objective: "objective",
            estimatedMinutes: 20,
            contentType: "TEXT",
            supportsSkillNames: [],
            citationIndices,
          },
        ],
      },
    ],
    assessmentStrategy: "Quiz per section",
  };
}

let lastCitationIndices: number[] = [];
vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    generateObject: vi.fn().mockImplementation(async () => ({
      object: fakeProposal(lastCitationIndices),
      usage: { inputTokens: 10, outputTokens: 20 },
    })),
  };
});

const { generateCourseProposal } = await import("@/lib/domain/course-creator/generate");

afterAll(async () => {
  await db.$disconnect();
});

describe("generateCourseProposal — AI policy boundary", () => {
  it("throws POLICY_DENIED if called for a surface whose policy denies GENERATE (defensive — no such surface exists today)", async () => {
    const { tenant, ctx } = await createTenantUser("INSTRUCTOR");
    void tenant;
    const reqCtx = { auth: ctx, surface: "SEARCH" } as AIRequestContext;
    lastCitationIndices = [];
    await expect(
      generateCourseProposal(reqCtx, {
        goal: "Teach reps to qualify B2B leads",
        assessmentStyle: "MCQ",
      })
    ).rejects.toThrow(AIRuntimeError);
  });

  it("throws for a tenant-less request rather than generating unscoped", async () => {
    const { ctx } = await createTenantUser("INSTRUCTOR");
    const reqCtx: AIRequestContext = {
      auth: { ...ctx, tenantId: null },
      surface: "COURSE_CREATOR",
    };
    await expect(
      generateCourseProposal(reqCtx, {
        goal: "Teach reps to qualify B2B leads",
        assessmentStyle: "MCQ",
      })
    ).rejects.toThrow();
  });
});

describe("generateCourseProposal — Knowledge authorization", () => {
  it("never includes another tenant's Knowledge in the retrieved context, even when selected by id", async () => {
    const { tenant: tenantA, ctx: ctxA } = await createTenantUser("INSTRUCTOR");
    const { tenant: tenantB } = await createTenantUser("INSTRUCTOR");

    const { document: docA } = await createIndexedDocument({
      tenantId: tenantA.id,
      title: "Tenant A doc",
      content: "tenant a content",
      embedding: QUERY_VECTOR,
    });
    const { document: docB } = await createIndexedDocument({
      tenantId: tenantB.id,
      title: "Tenant B SECRET doc",
      content: "tenant b secret content",
      embedding: QUERY_VECTOR,
    });

    const reqCtx: AIRequestContext = { auth: ctxA, surface: "COURSE_CREATOR" };
    lastCitationIndices = [];
    const result = await generateCourseProposal(reqCtx, {
      goal: "Teach reps to qualify B2B leads",
      assessmentStyle: "MCQ",
      // Attacker/mistaken attempt: ask for tenant B's document id from tenant A's context.
      knowledgeDocumentIds: [docA.id, docB.id],
    });

    expect(result.knowledge.every((k) => k.documentId === docA.id)).toBe(true);
    expect(result.knowledge.some((k) => k.documentId === docB.id)).toBe(false);
  });

  it("citations persisted/returned correspond only to knowledge actually retrieved and referenced by index", async () => {
    const { tenant, ctx } = await createTenantUser("INSTRUCTOR");
    await createIndexedDocument({
      tenantId: tenant.id,
      title: "Doc 0",
      content: "content zero",
      embedding: QUERY_VECTOR,
    });
    await createIndexedDocument({
      tenantId: tenant.id,
      title: "Doc 1",
      content: "content one",
      embedding: QUERY_VECTOR,
    });

    const reqCtx: AIRequestContext = { auth: ctx, surface: "COURSE_CREATOR" };
    lastCitationIndices = [0];
    const result = await generateCourseProposal(reqCtx, {
      goal: "Teach reps to qualify B2B leads",
      assessmentStyle: "MCQ",
    });

    expect(result.proposal.sections[0].lessons[0].citationIndices).toEqual([0]);
    expect(result.executionId).toBeDefined();
    const citations = await db.aISourceCitation.findMany({
      where: { conversationId: result.conversationId },
    });
    // Exactly the referenced (index 0) knowledge item was persisted as a citation.
    expect(citations).toHaveLength(1);
    expect(citations[0].knowledgeChunkId).toBe(result.knowledge[0].chunkId);
  });
});

describe("generateCourseProposal — AIExecution reaches a terminal state on model failure", () => {
  it("marks the execution FAILED and rethrows when generateObject throws", async () => {
    const ai = await import("ai");
    const { tenant, ctx } = await createTenantUser("INSTRUCTOR");
    void tenant;
    const mocked = vi.mocked(ai.generateObject);
    mocked.mockRejectedValueOnce(new Error("model unavailable"));

    const reqCtx: AIRequestContext = { auth: ctx, surface: "COURSE_CREATOR" };
    await expect(
      generateCourseProposal(reqCtx, {
        goal: "Teach reps to qualify B2B leads",
        assessmentStyle: "MCQ",
      })
    ).rejects.toThrow("model unavailable");

    const executions = await db.aIExecution.findMany({ where: { userId: ctx.userId } });
    expect(executions).toHaveLength(1);
    expect(executions[0].status).toBe("FAILED");
  });
});
