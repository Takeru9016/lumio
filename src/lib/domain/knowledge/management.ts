import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import type { KnowledgeAccessContext } from "@/lib/domain/knowledge/access";

/**
 * Phase 14 — Knowledge Ingestion & Management. This file adds the one thing
 * ingestion.ts/access.ts don't have: "who may manage (not merely read) a
 * document." It never duplicates ingestion (createTextDocument/indexDocument
 * are called directly by routes) and never touches canReadKnowledgeDocument
 * or searchKnowledge's authorization — read-time and manage-time
 * authorization are deliberately separate concepts.
 */

export type ManageableDocument = {
  tenantId: string;
  metadata: Prisma.JsonValue | null;
};

function createdByUserId(metadata: Prisma.JsonValue | null): string | null {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const value = (metadata as Record<string, unknown>).createdByUserId;
    if (typeof value === "string") return value;
  }
  return null;
}

/**
 * Pure predicate — no I/O. SUPER_ADMIN is explicitly denied (locked
 * correction to the Phase 14 contract: no tenant-wide or global shortcut for
 * Knowledge management, unlike capability reports). ORG_ADMIN may manage any
 * document in their own tenant; INSTRUCTOR only documents whose
 * metadata.createdByUserId matches their own id. Everyone else: false.
 */
export function canManageKnowledgeDocument(
  ctx: KnowledgeAccessContext,
  document: ManageableDocument
): boolean {
  if (document.tenantId !== ctx.tenantId) return false;

  if (ctx.role === "ORG_ADMIN") return true;
  if (ctx.role === "INSTRUCTOR") return createdByUserId(document.metadata) === ctx.userId;
  return false;
}

/**
 * Finds-or-creates the one KnowledgeSource that represents "documents this
 * staff member created directly" (type DOCUMENT, externalId = ctx.userId) —
 * the same found-or-created-per-owner pattern lessonBridge.ts already
 * established for per-course sources, reused here rather than invented.
 *
 * No unique constraint exists on (tenantId, type, externalId) in the current
 * schema, so two concurrent first-ever requests from the same user could in
 * principle each create a source. That's the smallest safe implementation
 * for this phase: a harmless, rare duplicate source (not a security or
 * correctness issue — every document still resolves to the correct owner via
 * its own metadata), not a reason to add a schema constraint this phase
 * doesn't otherwise need.
 */
export async function findOrCreateCreatorSource(ctx: KnowledgeAccessContext) {
  const existing = await db.knowledgeSource.findFirst({
    where: { tenantId: ctx.tenantId, type: "DOCUMENT", externalId: ctx.userId },
  });
  if (existing) return existing;

  return db.knowledgeSource.create({
    data: {
      tenantId: ctx.tenantId,
      type: "DOCUMENT",
      externalId: ctx.userId,
      name: "My Knowledge Documents",
    },
  });
}

/**
 * Grants the creator themselves read access to their own RESTRICTED
 * document. Always server-derived (ctx.userId) — never accepts a
 * client-supplied identity.
 */
export async function grantOwnerAccess(ctx: KnowledgeAccessContext, documentId: string) {
  return db.knowledgeAccess.create({
    data: { tenantId: ctx.tenantId, documentId, scope: "USER", userId: ctx.userId },
  });
}

export type ManagedDocumentListItem = {
  id: string;
  title: string;
  status: string;
  visibility: string;
  createdAt: Date;
  sourceType: string;
  createdByUserId: string | null;
  createdByName: string | null;
};

const MAX_RESULTS = 100;

/**
 * Staff management list — unlike listReadableKnowledgeDocuments (Phase 8
 * picker), this returns every status (PENDING/PROCESSING/READY/ERROR), never
 * filters to READY, and never touches canReadKnowledgeDocument. ORG_ADMIN
 * sees every document in the tenant; INSTRUCTOR sees only documents whose
 * metadata.createdByUserId matches their own id, via a Prisma JSON-path
 * filter (no read of every tenant document followed by an in-app filter).
 * Never exposes chunk content, embeddings, or KnowledgeAccess rows.
 */
export async function listManageableKnowledgeDocuments(
  ctx: KnowledgeAccessContext
): Promise<ManagedDocumentListItem[]> {
  const where: Prisma.KnowledgeDocumentWhereInput =
    ctx.role === "INSTRUCTOR"
      ? { tenantId: ctx.tenantId, metadata: { path: ["createdByUserId"], equals: ctx.userId } }
      : { tenantId: ctx.tenantId };

  const documents = await db.knowledgeDocument.findMany({
    where,
    select: {
      id: true,
      title: true,
      status: true,
      visibility: true,
      createdAt: true,
      metadata: true,
      source: { select: { type: true } },
    },
    orderBy: { createdAt: "desc" },
    take: MAX_RESULTS,
  });

  const creatorIds = Array.from(
    new Set(documents.map((d) => createdByUserId(d.metadata)).filter((id): id is string => !!id))
  );
  const creators =
    ctx.role === "ORG_ADMIN" && creatorIds.length > 0
      ? await db.user.findMany({
          where: { id: { in: creatorIds } },
          select: { id: true, name: true },
        })
      : [];
  const creatorNameById = new Map(creators.map((c) => [c.id, c.name]));

  return documents.map((d) => {
    const creatorId = createdByUserId(d.metadata);
    return {
      id: d.id,
      title: d.title,
      status: d.status,
      visibility: d.visibility,
      createdAt: d.createdAt,
      sourceType: d.source.type,
      createdByUserId: ctx.role === "ORG_ADMIN" ? creatorId : null,
      createdByName: creatorId ? (creatorNameById.get(creatorId) ?? null) : null,
    };
  });
}
