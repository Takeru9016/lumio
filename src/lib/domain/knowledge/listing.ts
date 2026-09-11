import { db } from "@/lib/db";
import {
  canReadKnowledgeDocument,
  getUserTeamIds,
  type KnowledgeAccessContext,
} from "@/lib/domain/knowledge/access";

export type KnowledgeDocumentListItem = {
  id: string;
  title: string;
  sourceId: string;
  sourceName: string;
};

const MAX_RESULTS = 100;

/**
 * Tenant + access-scoped list of Knowledge documents a caller may pick from
 * (Course Creator picker, Phase 8). Reuses canReadKnowledgeDocument — the
 * same predicate retrieval.ts and saveDraft.ts enforce — rather than a flat
 * tenant filter, so a RESTRICTED document the caller has no access row for
 * is excluded here exactly as it would be from retrieval.
 */
export async function listReadableKnowledgeDocuments(
  ctx: KnowledgeAccessContext
): Promise<KnowledgeDocumentListItem[]> {
  const [candidates, userTeamIds] = await Promise.all([
    db.knowledgeDocument.findMany({
      where: { tenantId: ctx.tenantId, status: "READY" },
      select: {
        id: true,
        title: true,
        tenantId: true,
        status: true,
        visibility: true,
        sourceId: true,
        source: { select: { name: true } },
      },
      orderBy: { title: "asc" },
      take: MAX_RESULTS,
    }),
    getUserTeamIds(ctx),
  ]);

  if (candidates.length === 0) return [];

  const restrictedIds = candidates.filter((d) => d.visibility === "RESTRICTED").map((d) => d.id);
  const accessRows =
    restrictedIds.length > 0
      ? await db.knowledgeAccess.findMany({
          where: { documentId: { in: restrictedIds }, tenantId: ctx.tenantId },
          select: { documentId: true, scope: true, teamId: true, userId: true },
        })
      : [];
  const accessRowsByDocument = new Map<string, typeof accessRows>();
  for (const row of accessRows) {
    const existing = accessRowsByDocument.get(row.documentId);
    if (existing) existing.push(row);
    else accessRowsByDocument.set(row.documentId, [row]);
  }

  return candidates
    .filter((d) =>
      canReadKnowledgeDocument(ctx, d, accessRowsByDocument.get(d.id) ?? [], userTeamIds)
    )
    .map((d) => ({ id: d.id, title: d.title, sourceId: d.sourceId, sourceName: d.source.name }));
}
