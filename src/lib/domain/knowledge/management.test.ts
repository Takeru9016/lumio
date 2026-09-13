import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createTenantUser } from "@/lib/domain/knowledge/__test__/fixtures";
import {
  canManageKnowledgeDocument,
  findOrCreateCreatorSource,
  grantOwnerAccess,
  listManageableKnowledgeDocuments,
} from "@/lib/domain/knowledge/management";

afterAll(async () => {
  await db.$disconnect();
});

describe("canManageKnowledgeDocument — pure predicate", () => {
  it("ORG_ADMIN can manage any document in their own tenant", () => {
    const ctx = { userId: "admin-1", clerkId: "c1", tenantId: "t1", role: "ORG_ADMIN" as const };
    expect(
      canManageKnowledgeDocument(ctx, {
        tenantId: "t1",
        metadata: { createdByUserId: "someone-else" },
      })
    ).toBe(true);
  });

  it("ORG_ADMIN cannot manage a document in another tenant", () => {
    const ctx = { userId: "admin-1", clerkId: "c1", tenantId: "t1", role: "ORG_ADMIN" as const };
    expect(canManageKnowledgeDocument(ctx, { tenantId: "t2", metadata: null })).toBe(false);
  });

  it("INSTRUCTOR can manage only their own document", () => {
    const ctx = {
      userId: "instructor-1",
      clerkId: "c1",
      tenantId: "t1",
      role: "INSTRUCTOR" as const,
    };
    expect(
      canManageKnowledgeDocument(ctx, {
        tenantId: "t1",
        metadata: { createdByUserId: "instructor-1" },
      })
    ).toBe(true);
  });

  it("INSTRUCTOR cannot manage a peer instructor's document", () => {
    const ctx = {
      userId: "instructor-1",
      clerkId: "c1",
      tenantId: "t1",
      role: "INSTRUCTOR" as const,
    };
    expect(
      canManageKnowledgeDocument(ctx, {
        tenantId: "t1",
        metadata: { createdByUserId: "instructor-2" },
      })
    ).toBe(false);
  });

  it("INSTRUCTOR cannot manage an ORG_ADMIN-created document", () => {
    const ctx = {
      userId: "instructor-1",
      clerkId: "c1",
      tenantId: "t1",
      role: "INSTRUCTOR" as const,
    };
    expect(
      canManageKnowledgeDocument(ctx, {
        tenantId: "t1",
        metadata: { createdByUserId: "admin-1", createdByRole: "ORG_ADMIN" },
      })
    ).toBe(false);
  });

  it("SUPER_ADMIN is always denied, even for a document in their own tenant", () => {
    const ctx = { userId: "super-1", clerkId: "c1", tenantId: "t1", role: "SUPER_ADMIN" as const };
    expect(
      canManageKnowledgeDocument(ctx, { tenantId: "t1", metadata: { createdByUserId: "super-1" } })
    ).toBe(false);
  });

  it("STUDENT is always denied", () => {
    const ctx = { userId: "student-1", clerkId: "c1", tenantId: "t1", role: "STUDENT" as const };
    expect(
      canManageKnowledgeDocument(ctx, {
        tenantId: "t1",
        metadata: { createdByUserId: "student-1" },
      })
    ).toBe(false);
  });

  it("treats missing/malformed metadata as no owner, not a crash", () => {
    const ctx = {
      userId: "instructor-1",
      clerkId: "c1",
      tenantId: "t1",
      role: "INSTRUCTOR" as const,
    };
    expect(canManageKnowledgeDocument(ctx, { tenantId: "t1", metadata: null })).toBe(false);
    expect(canManageKnowledgeDocument(ctx, { tenantId: "t1", metadata: "not-an-object" })).toBe(
      false
    );
  });
});

describe("findOrCreateCreatorSource", () => {
  it("creates one DOCUMENT-type source keyed by tenant + creator", async () => {
    const { ctx } = await createTenantUser("INSTRUCTOR");

    const source = await findOrCreateCreatorSource(ctx);

    expect(source.tenantId).toBe(ctx.tenantId);
    expect(source.type).toBe("DOCUMENT");
    expect(source.externalId).toBe(ctx.userId);
  });

  it("reuses the same source on a second call for the same creator", async () => {
    const { ctx } = await createTenantUser("INSTRUCTOR");

    const first = await findOrCreateCreatorSource(ctx);
    const second = await findOrCreateCreatorSource(ctx);

    expect(second.id).toBe(first.id);
  });

  it("does not reuse another creator's source, even in the same tenant", async () => {
    const { ctx: instructorCtx, tenant } = await createTenantUser("INSTRUCTOR");
    const otherUser = await db.user.create({
      data: {
        clerkId: `clerk-${Date.now()}-other`,
        email: `other-${Date.now()}@example.test`,
        tenantId: tenant.id,
        role: "INSTRUCTOR",
      },
    });
    const otherCtx = { ...instructorCtx, userId: otherUser.id };

    const mine = await findOrCreateCreatorSource(instructorCtx);
    const theirs = await findOrCreateCreatorSource(otherCtx);

    expect(mine.id).not.toBe(theirs.id);
  });
});

describe("grantOwnerAccess", () => {
  it("creates a USER-scope KnowledgeAccess row for the caller, never a client-supplied identity", async () => {
    const { ctx } = await createTenantUser("INSTRUCTOR");
    const source = await findOrCreateCreatorSource(ctx);
    const document = await db.knowledgeDocument.create({
      data: {
        tenantId: ctx.tenantId,
        sourceId: source.id,
        title: "private draft",
        textContent: "x",
        visibility: "RESTRICTED",
      },
    });

    await grantOwnerAccess(ctx, document.id);

    const rows = await db.knowledgeAccess.findMany({ where: { documentId: document.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].scope).toBe("USER");
    expect(rows[0].userId).toBe(ctx.userId);
  });
});

describe("listManageableKnowledgeDocuments", () => {
  async function createDoc(
    ctx: Awaited<ReturnType<typeof createTenantUser>>["ctx"],
    title: string,
    creatorUserId: string,
    creatorRole: string
  ) {
    const source = await findOrCreateCreatorSource({ ...ctx, userId: creatorUserId });
    return db.knowledgeDocument.create({
      data: {
        tenantId: ctx.tenantId,
        sourceId: source.id,
        title,
        textContent: "x",
        status: "READY",
        metadata: { createdByUserId: creatorUserId, createdByRole: creatorRole },
      },
    });
  }

  it("ORG_ADMIN sees every document in the tenant, including non-READY ones", async () => {
    const { ctx: adminCtx, tenant } = await createTenantUser("ORG_ADMIN");
    const instructor = await db.user.create({
      data: {
        clerkId: `clerk-${Date.now()}-i`,
        email: `i-${Date.now()}@example.test`,
        tenantId: tenant.id,
        role: "INSTRUCTOR",
      },
    });
    await createDoc(adminCtx, "admin doc", adminCtx.userId, "ORG_ADMIN");
    const instructorDoc = await createDoc(adminCtx, "instructor doc", instructor.id, "INSTRUCTOR");
    await db.knowledgeDocument.update({
      where: { id: instructorDoc.id },
      data: { status: "ERROR" },
    });

    const result = await listManageableKnowledgeDocuments(adminCtx);

    expect(result.map((d) => d.title).sort()).toEqual(["admin doc", "instructor doc"]);
    const errored = result.find((d) => d.title === "instructor doc");
    expect(errored?.status).toBe("ERROR");
    expect(errored?.createdByName).toBeDefined();
  });

  it("INSTRUCTOR sees only their own documents, never a peer's or ORG_ADMIN's", async () => {
    const { ctx: adminCtx, tenant } = await createTenantUser("ORG_ADMIN");
    const instructorA = await db.user.create({
      data: {
        clerkId: `clerk-${Date.now()}-a`,
        email: `a-${Date.now()}@example.test`,
        tenantId: tenant.id,
        role: "INSTRUCTOR",
      },
    });
    const instructorB = await db.user.create({
      data: {
        clerkId: `clerk-${Date.now()}-b`,
        email: `b-${Date.now()}@example.test`,
        tenantId: tenant.id,
        role: "INSTRUCTOR",
      },
    });
    await createDoc(adminCtx, "admin doc", adminCtx.userId, "ORG_ADMIN");
    await createDoc(adminCtx, "instructor A doc", instructorA.id, "INSTRUCTOR");
    await createDoc(adminCtx, "instructor B doc", instructorB.id, "INSTRUCTOR");

    const instructorACtx = { ...adminCtx, userId: instructorA.id, role: "INSTRUCTOR" as const };
    const result = await listManageableKnowledgeDocuments(instructorACtx);

    expect(result.map((d) => d.title)).toEqual(["instructor A doc"]);
  });

  it("never exposes chunk content, embeddings, or KnowledgeAccess rows", async () => {
    const { ctx } = await createTenantUser("ORG_ADMIN");
    await createDoc(ctx, "doc", ctx.userId, "ORG_ADMIN");

    const result = await listManageableKnowledgeDocuments(ctx);

    for (const doc of result) {
      expect(Object.keys(doc)).not.toContain("chunks");
      expect(Object.keys(doc)).not.toContain("embedding");
      expect(Object.keys(doc)).not.toContain("access");
    }
  });
});
