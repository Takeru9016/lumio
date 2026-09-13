import { z } from "zod";
import type { AuthContext } from "@/lib/auth/context";
import {
  AuthContextError,
  requireAuthContext,
  requireRole,
  requireTenant,
} from "@/lib/auth/context";
import { db } from "@/lib/db";
import { indexDocument } from "@/lib/domain/knowledge/ingestion";
import { canManageKnowledgeDocument } from "@/lib/domain/knowledge/management";

type Params = { params: Promise<{ id: string }> };

const DOCUMENT_SELECT = {
  id: true,
  tenantId: true,
  title: true,
  status: true,
  visibility: true,
  createdAt: true,
  metadata: true,
} as const;

/**
 * Looks up the document scoped to {id, tenantId} in one query — never an
 * unscoped findUnique followed by a tenant check — then applies
 * canManageKnowledgeDocument. A cross-tenant or nonexistent id and an
 * in-tenant id the caller may not manage both need to be distinguishable by
 * the caller (404 vs 403), but neither ever discloses whether a document
 * exists in ANOTHER tenant.
 */
async function resolveManageableDocument(ctx: AuthContext & { tenantId: string }, id: string) {
  const document = await db.knowledgeDocument.findFirst({
    where: { id, tenantId: ctx.tenantId },
    select: DOCUMENT_SELECT,
  });
  if (!document) return { outcome: "not_found" as const };
  if (!canManageKnowledgeDocument(ctx, document)) return { outcome: "forbidden" as const };
  return { outcome: "ok" as const, document };
}

const patchSchema = z.object({ action: z.literal("reindex") }).strict();

/**
 * Phase 14 — retry/reindex only. No content editing in this phase (to
 * change text content, delete and recreate) — reuses indexDocument()
 * exactly as ingestion.ts already implements it, including its own
 * READY/ERROR status handling.
 */
export async function PATCH(req: Request, { params }: Params) {
  let ctx: Awaited<ReturnType<typeof requireAuthContext>>;
  try {
    ctx = await requireAuthContext();
    requireTenant(ctx);
    requireRole(ctx, ["INSTRUCTOR", "ORG_ADMIN"]);
  } catch (err) {
    if (err instanceof AuthContextError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!patchSchema.safeParse(rawBody).success) {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { id } = await params;
  const resolved = await resolveManageableDocument(ctx, id);
  if (resolved.outcome === "not_found") {
    return Response.json({ error: "Document not found" }, { status: 404 });
  }
  if (resolved.outcome === "forbidden") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    await indexDocument(ctx, resolved.document.id);
  } catch (err) {
    console.error("[knowledge] Reindex failed", resolved.document.id, err);
  }

  const finalDocument = await db.knowledgeDocument.findUniqueOrThrow({
    where: { id: resolved.document.id },
    select: { id: true, title: true, status: true, visibility: true, createdAt: true },
  });

  return Response.json({ document: finalDocument });
}

/**
 * Phase 14 — hard delete only, no soft-delete/archive state (none exists in
 * the current KnowledgeStatus enum, and adding one isn't justified — see
 * Phase 14 contract §13). Relies on the existing onDelete: Cascade from
 * KnowledgeChunk.document and KnowledgeAccess.document.
 */
export async function DELETE(_req: Request, { params }: Params) {
  let ctx: Awaited<ReturnType<typeof requireAuthContext>>;
  try {
    ctx = await requireAuthContext();
    requireTenant(ctx);
    requireRole(ctx, ["INSTRUCTOR", "ORG_ADMIN"]);
  } catch (err) {
    if (err instanceof AuthContextError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  const { id } = await params;
  const resolved = await resolveManageableDocument(ctx, id);
  if (resolved.outcome === "not_found") {
    return Response.json({ error: "Document not found" }, { status: 404 });
  }
  if (resolved.outcome === "forbidden") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  await db.knowledgeDocument.delete({ where: { id: resolved.document.id } });

  return Response.json({ success: true });
}
