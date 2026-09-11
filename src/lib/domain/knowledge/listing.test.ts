import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  addTeamMember,
  createIndexedDocument,
  createTeam,
  createTenantUser,
  fakeEmbedding,
  grantAccess,
} from "@/lib/domain/knowledge/__test__/fixtures";
import { listReadableKnowledgeDocuments } from "@/lib/domain/knowledge/listing";

afterAll(async () => {
  await db.$disconnect();
});

describe("listReadableKnowledgeDocuments — security matrix", () => {
  it("empty tenant -> empty result", async () => {
    const { ctx } = await createTenantUser("INSTRUCTOR");
    const result = await listReadableKnowledgeDocuments(ctx);
    expect(result).toEqual([]);
  });

  it("a READY, TENANT-visibility document is included", async () => {
    const { tenant, ctx } = await createTenantUser("INSTRUCTOR");
    const { document, source } = await createIndexedDocument({
      tenantId: tenant.id,
      title: "Onboarding Guide",
      content: "content",
      embedding: fakeEmbedding(1),
    });

    const result = await listReadableKnowledgeDocuments(ctx);

    expect(result).toEqual([
      {
        id: document.id,
        title: document.title,
        sourceId: document.sourceId,
        sourceName: source.name,
      },
    ]);
  });

  it("a RESTRICTED document with no matching access row is excluded", async () => {
    const { tenant, ctx } = await createTenantUser("INSTRUCTOR");
    await createIndexedDocument({
      tenantId: tenant.id,
      title: "Restricted doc",
      content: "content",
      embedding: fakeEmbedding(2),
      visibility: "RESTRICTED",
    });

    const result = await listReadableKnowledgeDocuments(ctx);
    expect(result).toEqual([]);
  });

  it("a RESTRICTED document with a USER-scoped access row is included", async () => {
    const { tenant, ctx } = await createTenantUser("INSTRUCTOR");
    const { document } = await createIndexedDocument({
      tenantId: tenant.id,
      title: "Restricted doc",
      content: "content",
      embedding: fakeEmbedding(3),
      visibility: "RESTRICTED",
    });
    await grantAccess({
      tenantId: tenant.id,
      documentId: document.id,
      scope: "USER",
      userId: ctx.userId,
    });

    const result = await listReadableKnowledgeDocuments(ctx);
    expect(result.map((d) => d.id)).toEqual([document.id]);
  });

  it("a RESTRICTED document with a TEAM-scoped access row is included only for a member of that team", async () => {
    const { tenant, ctx } = await createTenantUser("INSTRUCTOR");
    const team = await createTeam(tenant.id);
    await addTeamMember(team.id, ctx.userId);
    const { document } = await createIndexedDocument({
      tenantId: tenant.id,
      title: "Team doc",
      content: "content",
      embedding: fakeEmbedding(4),
      visibility: "RESTRICTED",
    });
    await grantAccess({
      tenantId: tenant.id,
      documentId: document.id,
      scope: "TEAM",
      teamId: team.id,
    });

    const result = await listReadableKnowledgeDocuments(ctx);
    expect(result.map((d) => d.id)).toEqual([document.id]);
  });

  it("a PENDING-status document is excluded even if TENANT-visible", async () => {
    const { tenant, ctx } = await createTenantUser("INSTRUCTOR");
    const source = await db.knowledgeSource.create({
      data: { tenantId: tenant.id, type: "MANUAL", name: "src" },
    });
    await db.knowledgeDocument.create({
      data: {
        tenantId: tenant.id,
        sourceId: source.id,
        title: "Still indexing",
        status: "PENDING",
        visibility: "TENANT",
      },
    });

    const result = await listReadableKnowledgeDocuments(ctx);
    expect(result).toEqual([]);
  });

  it("another tenant's document never appears", async () => {
    const { ctx } = await createTenantUser("INSTRUCTOR");
    const { tenant: otherTenant } = await createTenantUser("INSTRUCTOR");
    await createIndexedDocument({
      tenantId: otherTenant.id,
      title: "Other tenant doc",
      content: "content",
      embedding: fakeEmbedding(5),
    });

    const result = await listReadableKnowledgeDocuments(ctx);
    expect(result).toEqual([]);
  });

  it("results are ordered by title ascending", async () => {
    const { tenant, ctx } = await createTenantUser("INSTRUCTOR");
    await createIndexedDocument({
      tenantId: tenant.id,
      title: "Zebra",
      content: "content",
      embedding: fakeEmbedding(6),
    });
    await createIndexedDocument({
      tenantId: tenant.id,
      title: "Alpha",
      content: "content",
      embedding: fakeEmbedding(7),
    });

    const result = await listReadableKnowledgeDocuments(ctx);
    expect(result.map((d) => d.title)).toEqual(["Alpha", "Zebra"]);
  });
});
