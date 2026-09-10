import { afterAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  addTeamMember,
  createIndexedDocument,
  createTeam,
  createTenantUser,
  fakeEmbedding,
  grantAccess,
} from "@/lib/domain/knowledge/__test__/fixtures";
import { KnowledgeAccessError } from "@/lib/domain/knowledge/access";

// generateEmbedding normally calls OpenAI. These tests exercise real
// Postgres/pgvector + the real authorization SQL in retrieval.ts — only the
// embedding call itself is mocked, to a fixed deterministic vector, so
// results are controlled by the WHERE clause under test, not live model
// output. toVectorLiteral is the real implementation (trivial + pure).
const QUERY_VECTOR = fakeEmbedding(999);
vi.mock("@/lib/ai/embeddings", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/embeddings")>("@/lib/ai/embeddings");
  return {
    ...actual,
    generateEmbedding: vi.fn().mockResolvedValue(QUERY_VECTOR),
  };
});

const { searchKnowledge } = await import("@/lib/domain/knowledge/retrieval");
const { createTextDocument, indexDocument } = await import("@/lib/domain/knowledge/ingestion");

afterAll(async () => {
  await db.$disconnect();
});

describe("Knowledge retrieval — tenant isolation", () => {
  it("never returns another tenant's TENANT-visibility content, even at identical similarity", async () => {
    const { tenant: tenantA, ctx: ctxA } = await createTenantUser();
    const { tenant: tenantB } = await createTenantUser();

    const { document: docA, chunk: chunkA } = await createIndexedDocument({
      tenantId: tenantA.id,
      title: "Tenant A doc",
      content: "tenant a content",
      embedding: QUERY_VECTOR, // identical to the query — best possible match
    });
    const { document: docB, chunk: chunkB } = await createIndexedDocument({
      tenantId: tenantB.id,
      title: "Tenant B SECRET doc",
      content: "tenant b secret content",
      embedding: QUERY_VECTOR, // also identical — same rank as tenant A's
    });

    const results = await searchKnowledge(ctxA, "anything (mocked)");

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.documentId === docA.id)).toBe(true);
    expect(results.some((r) => r.documentId === docB.id)).toBe(false);
    expect(results.some((r) => r.chunkId === chunkB.id)).toBe(false);
    // Leakage check beyond just documentId: content, citation, metadata must
    // never carry tenant B's title/text either.
    for (const r of results) {
      expect(r.content).not.toContain("secret");
      expect(r.citation.documentTitle).not.toBe("Tenant B SECRET doc");
      expect(JSON.stringify(r.metadata ?? {})).not.toContain("secret");
    }
    expect(results.some((r) => r.chunkId === chunkA.id)).toBe(true);
  });

  it("returns nothing (not an error) when the tenant has no matching content", async () => {
    const { ctx } = await createTenantUser();
    const results = await searchKnowledge(ctx, "anything (mocked)");
    expect(results).toEqual([]);
  });
});

describe("Knowledge retrieval — user-specific access", () => {
  it("a USER-restricted document is retrievable by that user and not by another in the same tenant", async () => {
    const { tenant, ctx: ownerCtx, user: owner } = await createTenantUser();
    const { ctx: otherCtx } = await createTenantUser(); // different tenant, irrelevant
    const otherSameTenant = await db.user.create({
      data: {
        clerkId: `clerk-${Date.now()}-x`,
        email: `other-${Date.now()}@example.test`,
        tenantId: tenant.id,
      },
    });
    const otherSameTenantCtx = {
      userId: otherSameTenant.id,
      clerkId: otherSameTenant.clerkId,
      tenantId: tenant.id,
      role: otherSameTenant.role,
    };

    const { document } = await createIndexedDocument({
      tenantId: tenant.id,
      title: "User-restricted doc",
      content: "only the owner should see this",
      embedding: QUERY_VECTOR,
      visibility: "RESTRICTED",
    });
    await grantAccess({
      tenantId: tenant.id,
      documentId: document.id,
      scope: "USER",
      userId: owner.id,
    });

    const ownerResults = await searchKnowledge(ownerCtx, "q");
    expect(ownerResults.some((r) => r.documentId === document.id)).toBe(true);

    const otherResults = await searchKnowledge(otherSameTenantCtx, "q");
    expect(otherResults.some((r) => r.documentId === document.id)).toBe(false);

    // Sanity: an unrelated tenant's context also can't see it (belt and suspenders).
    const crossTenantResults = await searchKnowledge(otherCtx, "q");
    expect(crossTenantResults.some((r) => r.documentId === document.id)).toBe(false);
  });
});

describe("Knowledge retrieval — team access", () => {
  it("a TEAM-restricted document is retrievable by team members and not by non-members", async () => {
    const { tenant, ctx: memberCtx, user: member } = await createTenantUser();
    const nonMember = await db.user.create({
      data: {
        clerkId: `clerk-${Date.now()}-nm`,
        email: `nonmember-${Date.now()}@example.test`,
        tenantId: tenant.id,
      },
    });
    const nonMemberCtx = {
      userId: nonMember.id,
      clerkId: nonMember.clerkId,
      tenantId: tenant.id,
      role: nonMember.role,
    };

    const team = await createTeam(tenant.id);
    await addTeamMember(team.id, member.id);

    const { document } = await createIndexedDocument({
      tenantId: tenant.id,
      title: "Team-restricted doc",
      content: "only team members should see this",
      embedding: QUERY_VECTOR,
      visibility: "RESTRICTED",
    });
    await grantAccess({
      tenantId: tenant.id,
      documentId: document.id,
      scope: "TEAM",
      teamId: team.id,
    });

    const memberResults = await searchKnowledge(memberCtx, "q");
    expect(memberResults.some((r) => r.documentId === document.id)).toBe(true);

    const nonMemberResults = await searchKnowledge(nonMemberCtx, "q");
    expect(nonMemberResults.some((r) => r.documentId === document.id)).toBe(false);
  });
});

describe("Knowledge writes — cross-tenant relationship protection", () => {
  it("rejects creating a document whose source belongs to a different tenant", async () => {
    const { ctx: ctxA } = await createTenantUser();
    const { tenant: tenantB } = await createTenantUser();
    const sourceB = await db.knowledgeSource.create({
      data: { tenantId: tenantB.id, type: "MANUAL", name: "tenant b source" },
    });

    await expect(
      createTextDocument(ctxA, {
        sourceId: sourceB.id,
        title: "cross-tenant attempt",
        textContent: "x",
      })
    ).rejects.toThrow(KnowledgeAccessError);
  });

  it("rejects indexing a document belonging to a different tenant", async () => {
    const { ctx: ctxA } = await createTenantUser();
    const { tenant: tenantB, ctx: ctxB } = await createTenantUser();
    const sourceB = await db.knowledgeSource.create({
      data: { tenantId: tenantB.id, type: "MANUAL", name: "tenant b source" },
    });
    const docB = await createTextDocument(ctxB, {
      sourceId: sourceB.id,
      title: "tenant b doc",
      textContent: "hello world",
    });

    await expect(indexDocument(ctxA, docB.id)).rejects.toThrow(KnowledgeAccessError);
  });
});
