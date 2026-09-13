import { z } from "zod";
import {
  AuthContextError,
  requireAuthContext,
  requireRole,
  requireTenant,
} from "@/lib/auth/context";
import { db } from "@/lib/db";
import { createTextDocument, indexDocument } from "@/lib/domain/knowledge/ingestion";
import { listReadableKnowledgeDocuments } from "@/lib/domain/knowledge/listing";
import { findOrCreateCreatorSource, grantOwnerAccess } from "@/lib/domain/knowledge/management";

/**
 * Read-only, tenant + access-scoped Knowledge document listing for picker
 * UIs (Course Creator, Phase 8 locked contract §4/§7). Self-scoped only —
 * tenantId always comes from the resolved AuthContext. No pagination or
 * search: bounded to MAX_RESULTS by listReadableKnowledgeDocuments.
 *
 * UNCHANGED by Phase 14 — behavior, authorization, and response shape are
 * identical to Phase 8. Phase 14's own management listing lives at a
 * separate path (GET /api/knowledge/documents/manage) specifically so this
 * handler never needs role-based branching.
 */
export async function GET(_req: Request) {
  let ctx: Awaited<ReturnType<typeof requireAuthContext>>;
  try {
    ctx = await requireAuthContext();
    requireTenant(ctx);
  } catch (err) {
    if (err instanceof AuthContextError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  try {
    const documents = await listReadableKnowledgeDocuments(ctx);
    return Response.json({ documents });
  } catch (err) {
    console.error("[knowledge] Failed to list documents", err);
    return Response.json({ error: "Failed to list documents" }, { status: 500 });
  }
}

const MAX_TEXT_CONTENT_LENGTH = 50_000;

// .strict() rejects tenantId/userId/createdByUserId/createdByRole/sourceId
// outright — every identity field this route ever writes is server-derived
// from the resolved AuthContext, never accepted from the request body.
const createDocumentSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    textContent: z.string().min(1).max(MAX_TEXT_CONTENT_LENGTH),
    visibility: z.enum(["TENANT", "RESTRICTED"]).optional(),
  })
  .strict();

/**
 * Phase 14 — staff Knowledge document creation. INSTRUCTOR and ORG_ADMIN
 * only (SUPER_ADMIN explicitly denied, per the locked Phase 14 role
 * correction — no shortcut). Creates the document, then indexes it
 * SYNCHRONOUSLY in the same request (no queue/worker — see contract §6):
 * indexDocument() itself is responsible for setting the final READY/ERROR
 * status, so this handler never has to guess or fake the outcome. A creation
 * that succeeds but whose indexing fails still returns 200 — the document
 * was created; only its indexing failed, and that fact is reported in
 * `status`, not hidden behind an HTTP error.
 */
export async function POST(req: Request) {
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

  const parsed = createDocumentSchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }
  const { title, textContent, visibility } = parsed.data;

  try {
    const source = await findOrCreateCreatorSource(ctx);
    const document = await createTextDocument(ctx, {
      sourceId: source.id,
      title,
      textContent,
      visibility: visibility ?? "TENANT",
      metadata: { createdByUserId: ctx.userId, createdByRole: ctx.role },
    });

    if (document.visibility === "RESTRICTED") {
      await grantOwnerAccess(ctx, document.id);
    }

    try {
      await indexDocument(ctx, document.id);
    } catch (err) {
      // indexDocument already persisted status: "ERROR" internally before
      // rethrowing — nothing further to do here except let the refetch below
      // pick up that outcome. Logged for operability, never surfaced raw.
      console.error("[knowledge] Indexing failed for new document", document.id, err);
    }

    const finalDocument = await db.knowledgeDocument.findUniqueOrThrow({
      where: { id: document.id },
      select: { id: true, title: true, status: true, visibility: true, createdAt: true },
    });

    return Response.json({ document: finalDocument });
  } catch (err) {
    console.error("[knowledge] Failed to create document", err);
    return Response.json({ error: "Failed to create document" }, { status: 500 });
  }
}
