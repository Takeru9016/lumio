import type { AuthContext } from "@/lib/auth/context";
import { requireAuthContext, requireTenant } from "@/lib/auth/context";
import { db } from "@/lib/db";

/**
 * Every Knowledge operation requires a tenant — there is no "global" Knowledge
 * scope. Narrower than AuthContext (tenantId non-null) so a caller can't
 * accidentally pass a tenant-less context into a Knowledge function.
 */
export type KnowledgeAccessContext = AuthContext & { tenantId: string };

export class KnowledgeAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeAccessError";
  }
}

/** Resolves the current session to a tenant-scoped KnowledgeAccessContext, or throws. */
export async function requireKnowledgeAccessContext(): Promise<KnowledgeAccessContext> {
  const ctx = await requireAuthContext();
  requireTenant(ctx);
  return ctx;
}

/**
 * Throws unless every given record's tenantId matches. Use this at every
 * Knowledge write that joins tenant-owned records across tables (e.g. "does
 * this KnowledgeDocument's sourceId actually belong to a KnowledgeSource in
 * the same tenant") — nothing at the database level enforces this (see
 * docs/V2_DATABASE_MIGRATION.md, Phase 1 audit §8), so every write path must
 * call this explicitly instead of trusting caller-supplied ids.
 */
export function assertSameTenant(
  expectedTenantId: string,
  records: Array<{ tenantId: string; label?: string }>
): void {
  for (const record of records) {
    if (record.tenantId !== expectedTenantId) {
      throw new KnowledgeAccessError(
        `Cross-tenant reference detected${record.label ? ` (${record.label})` : ""}: expected tenant ${expectedTenantId}, got ${record.tenantId}`
      );
    }
  }
}

export type KnowledgeAccessScope = "TENANT" | "TEAM" | "USER";

export type KnowledgeDocumentAccessInput = {
  tenantId: string;
  status: string;
  visibility: "TENANT" | "RESTRICTED";
};

export type KnowledgeAccessRow = {
  scope: KnowledgeAccessScope;
  teamId: string | null;
  userId: string | null;
};

/**
 * Pure authorization predicate — no I/O, fully unit-testable. This is the
 * single source of truth for "can this user read this document"; the SQL in
 * retrieval.ts must implement the same logic inline (see that file's header
 * comment for why it can't just call this function), and access.test.ts
 * tests both against the same fixtures to keep them from drifting apart.
 *
 * Order matters: tenant boundary and READY status are hard gates checked
 * before visibility/access-row logic even runs.
 */
export function canReadKnowledgeDocument(
  ctx: KnowledgeAccessContext,
  document: KnowledgeDocumentAccessInput,
  accessRows: KnowledgeAccessRow[],
  userTeamIds: string[]
): boolean {
  if (document.tenantId !== ctx.tenantId) return false;
  if (document.status !== "READY") return false;
  if (document.visibility === "TENANT") return true;

  // RESTRICTED: fail closed — only an explicit matching row grants access.
  return accessRows.some((row) => {
    if (row.scope === "TENANT") return true;
    if (row.scope === "TEAM") return row.teamId !== null && userTeamIds.includes(row.teamId);
    if (row.scope === "USER") return row.userId === ctx.userId;
    return false;
  });
}

/** Loads the current user's team ids within their own tenant. */
export async function getUserTeamIds(ctx: KnowledgeAccessContext): Promise<string[]> {
  const memberships = await db.teamMember.findMany({
    where: { userId: ctx.userId, team: { tenantId: ctx.tenantId } },
    select: { teamId: true },
  });
  return memberships.map((m) => m.teamId);
}

/**
 * DB-backed convenience wrapper around canReadKnowledgeDocument for
 * single-document checks (e.g. a document detail page) — NOT used by
 * retrieval.ts, which inlines the equivalent filter directly in SQL so
 * authorization is enforced as part of the query, not after it (see
 * retrieval.ts).
 */
export async function canReadKnowledgeDocumentById(
  ctx: KnowledgeAccessContext,
  documentId: string
): Promise<boolean> {
  const document = await db.knowledgeDocument.findUnique({
    where: { id: documentId },
    select: { tenantId: true, status: true, visibility: true },
  });
  if (!document) return false;

  const [accessRows, userTeamIds] = await Promise.all([
    document.tenantId === ctx.tenantId
      ? db.knowledgeAccess.findMany({
          where: { documentId },
          select: { scope: true, teamId: true, userId: true },
        })
      : Promise.resolve([]),
    getUserTeamIds(ctx),
  ]);

  return canReadKnowledgeDocument(ctx, document, accessRows, userTeamIds);
}
