import { afterAll, describe, expect, it, vi } from "vitest";
import type { AIRequestContext } from "@/lib/ai/runtime/types";
import { db } from "@/lib/db";
import {
  createIndexedDocument,
  createTenantUser,
  fakeEmbedding,
} from "@/lib/domain/knowledge/__test__/fixtures";

const QUERY_VECTOR = fakeEmbedding(555);
vi.mock("@/lib/ai/embeddings", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/embeddings")>("@/lib/ai/embeddings");
  return { ...actual, generateEmbedding: vi.fn().mockResolvedValue(QUERY_VECTOR) };
});

const { buildAIContext } = await import("@/lib/ai/runtime/context");

afterAll(async () => {
  await db.$disconnect();
});

describe("buildAIContext — tenant isolation", () => {
  it("never includes another tenant's Knowledge, even at identical similarity", async () => {
    const { tenant: tenantA, ctx: ctxA } = await createTenantUser();
    const { tenant: tenantB } = await createTenantUser();

    const { document: docA } = await createIndexedDocument({
      tenantId: tenantA.id,
      title: "Tenant A doc",
      content: "tenant a content",
      embedding: QUERY_VECTOR,
    });
    await createIndexedDocument({
      tenantId: tenantB.id,
      title: "Tenant B SECRET doc",
      content: "tenant b secret content",
      embedding: QUERY_VECTOR,
    });

    const reqCtx: AIRequestContext = { auth: ctxA, surface: "TUTOR" };
    const context = await buildAIContext(reqCtx, { query: "anything (mocked)" });

    expect(context.knowledge.length).toBeGreaterThan(0);
    expect(context.knowledge.every((k) => k.documentId === docA.id)).toBe(true);
    expect(context.knowledge.some((k) => k.citation.documentTitle.includes("SECRET"))).toBe(false);
  });

  it("skips Knowledge retrieval entirely for a tenant-less (FREE-plan) context", async () => {
    const { ctx } = await createTenantUser();
    const freeCtx = { ...ctx, tenantId: null };
    const reqCtx: AIRequestContext = { auth: freeCtx, surface: "TUTOR" };

    const context = await buildAIContext(reqCtx, { query: "anything (mocked)" });
    expect(context.knowledge).toEqual([]);
    expect(context.tenantId).toBeNull();
  });

  it("skips Knowledge retrieval for a surface whose policy denies READ", async () => {
    const { tenant, ctx } = await createTenantUser();
    await createIndexedDocument({
      tenantId: tenant.id,
      title: "doc",
      content: "content",
      embedding: QUERY_VECTOR,
    });

    // No current surface denies READ, so this proves the wiring rather than
    // a real product case — see src/lib/ai/runtime/policy.ts.
    const reqCtx = { auth: ctx, surface: "SEARCH" } as AIRequestContext;
    const context = await buildAIContext(reqCtx, { query: undefined });
    expect(context.knowledge).toEqual([]);
  });
});

describe("buildAIContext — bounded, explicit context", () => {
  it("user DTO exposes only id/role/plan — no email, no aiCallsUsed, no billing fields", async () => {
    const { ctx } = await createTenantUser();
    const reqCtx: AIRequestContext = { auth: ctx, surface: "TUTOR" };

    const context = await buildAIContext(reqCtx);
    expect(Object.keys(context.user).sort()).toEqual(["id", "plan", "role"]);
  });

  it("course/lesson are optional and omitted when not requested", async () => {
    const { ctx } = await createTenantUser();
    const reqCtx: AIRequestContext = { auth: ctx, surface: "TUTOR" };

    const context = await buildAIContext(reqCtx);
    expect(context.course).toBeUndefined();
    expect(context.lesson).toBeUndefined();
  });

  it("preserves tenant and surface on the returned context", async () => {
    const { tenant, ctx } = await createTenantUser();
    const reqCtx: AIRequestContext = { auth: ctx, surface: "COURSE_CREATOR" };

    const context = await buildAIContext(reqCtx);
    expect(context.tenantId).toBe(tenant.id);
    expect(context.surface).toBe("COURSE_CREATOR");
    expect(context.user.id).toBe(ctx.userId);
  });
});
