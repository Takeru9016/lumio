import { db } from "@/lib/db";
import type { KnowledgeAccessContext } from "@/lib/domain/knowledge/access";

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

/** Creates a Tenant + User row and returns a ready-to-use KnowledgeAccessContext. */
export async function createTenantUser(role: "STUDENT" | "ORG_ADMIN" = "STUDENT") {
  const tenant = await db.tenant.create({
    data: { name: unique("tenant"), slug: unique("tenant-slug") },
  });
  const user = await db.user.create({
    data: {
      clerkId: unique("clerk"),
      email: `${unique("user")}@example.test`,
      tenantId: tenant.id,
      role,
    },
  });
  const ctx: KnowledgeAccessContext = {
    userId: user.id,
    clerkId: user.clerkId,
    tenantId: tenant.id,
    role: user.role,
  };
  return { tenant, user, ctx };
}

export async function createTeam(tenantId: string) {
  return db.team.create({ data: { name: unique("team"), tenantId } });
}

export async function addTeamMember(teamId: string, userId: string) {
  return db.teamMember.create({ data: { teamId, userId } });
}

/**
 * Creates a fully-indexed KnowledgeDocument (source + document + one chunk
 * with a real embedding) in one call, for tests that only care about
 * retrieval/authorization, not the ingestion pipeline itself.
 */
export async function createIndexedDocument(params: {
  tenantId: string;
  title: string;
  content: string;
  embedding: number[];
  visibility?: "TENANT" | "RESTRICTED";
}) {
  const source = await db.knowledgeSource.create({
    data: { tenantId: params.tenantId, type: "MANUAL", name: unique("source") },
  });
  const document = await db.knowledgeDocument.create({
    data: {
      tenantId: params.tenantId,
      sourceId: source.id,
      title: params.title,
      textContent: params.content,
      status: "READY",
      visibility: params.visibility ?? "TENANT",
      activeVersion: 1,
    },
  });
  const chunk = await db.knowledgeChunk.create({
    data: {
      tenantId: params.tenantId,
      documentId: document.id,
      content: params.content,
      chunkIndex: 0,
      version: 1,
    },
  });
  const vector = `[${params.embedding.join(",")}]`;
  await db.$executeRaw`UPDATE "KnowledgeChunk" SET embedding = ${vector}::vector WHERE id = ${chunk.id}`;

  return { source, document, chunk };
}

export async function grantAccess(params: {
  tenantId: string;
  documentId: string;
  scope: "TENANT" | "TEAM" | "USER";
  teamId?: string;
  userId?: string;
}) {
  return db.knowledgeAccess.create({
    data: {
      tenantId: params.tenantId,
      documentId: params.documentId,
      scope: params.scope,
      teamId: params.teamId,
      userId: params.userId,
    },
  });
}

/** A deterministic 1536-dim vector, distinct per `seed`, real cosine geometry. */
export function fakeEmbedding(seed: number): number[] {
  const v = new Array(1536).fill(0);
  for (let i = 0; i < 1536; i++) {
    v[i] = Math.sin(seed * 12.9898 + i * 78.233) * 0.5;
  }
  return v;
}
