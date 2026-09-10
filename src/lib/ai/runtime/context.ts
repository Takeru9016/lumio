import type { Plan, Role } from "@/generated/prisma/enums";
import { isActionAllowed } from "@/lib/ai/runtime/policy";
import type { AIRequestContext } from "@/lib/ai/runtime/types";
import { db } from "@/lib/db";
import type { KnowledgeAccessContext } from "@/lib/domain/knowledge/access";
import { searchKnowledge } from "@/lib/domain/knowledge/retrieval";

export type KnowledgeContextItem = {
  chunkId: string;
  documentId: string;
  sourceId: string;
  content: string;
  score: number;
  citation: { documentTitle: string; sourceId: string };
};

/**
 * Explicit, minimal context handed to the model — never a raw Prisma `User`/
 * `Tenant` row (those carry email, billing ids, `aiCallsUsed`, etc. — see
 * docs/V2_AI_ARCHITECTURE.md, "Context builder"). Course/lesson are
 * `{id, title}` only.
 *
 * `buildAIContext` trusts that the caller has already authorized
 * `courseId`/`lessonId` (e.g. the tutor route's existing enrollment guard) —
 * it hydrates display fields, it does not re-check enrollment. Knowledge
 * retrieval is the one piece that re-authorizes on every call, because
 * `searchKnowledge` requires its own tenant-scoped context regardless of
 * what the caller already checked.
 */
export type AIContextDTO = {
  surface: AIRequestContext["surface"];
  user: { id: string; role: Role; plan: Plan };
  tenantId: string | null;
  course?: { id: string; title: string };
  lesson?: { id: string; title: string };
  knowledge: KnowledgeContextItem[];
};

export type BuildAIContextOptions = {
  /** Natural-language query to retrieve Knowledge for. Omit to skip retrieval entirely. */
  query?: string;
  topK?: number;
};

/**
 * Builds the bounded context a model call is allowed to see. Knowledge
 * retrieval only runs when: the surface's policy allows READ, the request
 * has a tenant (FREE-plan users don't), and a query was given — matching the
 * same conditions the Phase 2 tutor integration used, now centralized here
 * instead of duplicated per route.
 *
 * Knowledge retrieval failures are logged and degrade to an empty knowledge
 * array rather than failing the whole context build — see
 * docs/V2_AI_ARCHITECTURE.md, "Error handling" for why this one failure mode
 * is allowed to degrade silently to the caller (not to the logs).
 */
export async function buildAIContext(
  reqCtx: AIRequestContext,
  options: BuildAIContextOptions = {}
): Promise<AIContextDTO> {
  const user = await db.user.findUnique({
    where: { id: reqCtx.auth.userId },
    select: { id: true, role: true, plan: true },
  });
  if (!user) {
    throw new Error(`buildAIContext: user ${reqCtx.auth.userId} not found`);
  }

  const [course, lesson] = await Promise.all([
    reqCtx.courseId
      ? db.course.findUnique({ where: { id: reqCtx.courseId }, select: { id: true, title: true } })
      : Promise.resolve(null),
    reqCtx.lessonId
      ? db.lesson.findUnique({ where: { id: reqCtx.lessonId }, select: { id: true, title: true } })
      : Promise.resolve(null),
  ]);

  let knowledge: KnowledgeContextItem[] = [];
  const { tenantId } = reqCtx.auth;
  const { query } = options;

  if (isActionAllowed(reqCtx.surface, "READ") && tenantId && query) {
    try {
      const knowledgeCtx: KnowledgeAccessContext = {
        userId: reqCtx.auth.userId,
        clerkId: reqCtx.auth.clerkId,
        tenantId,
        role: reqCtx.auth.role,
      };
      const results = await searchKnowledge(knowledgeCtx, query, { topK: options.topK });
      knowledge = results.map((r) => ({
        chunkId: r.chunkId,
        documentId: r.documentId,
        sourceId: r.sourceId,
        content: r.content,
        score: r.score,
        citation: r.citation,
      }));
    } catch (err) {
      // Knowledge retrieval is one input among several (lesson context is
      // still available) — a failure here degrades the response quality,
      // it does not make the request invalid, so this is logged, not thrown.
      console.error("[ai-runtime] Knowledge retrieval failed, continuing without it", err);
    }
  }

  return {
    surface: reqCtx.surface,
    user: { id: user.id, role: user.role, plan: user.plan },
    tenantId: reqCtx.auth.tenantId,
    course: course ?? undefined,
    lesson: lesson ?? undefined,
    knowledge,
  };
}
