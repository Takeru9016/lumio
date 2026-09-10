import { db } from "@/lib/db";
import { assertSameTenant, type KnowledgeAccessContext } from "@/lib/domain/knowledge/access";

/**
 * Bridge between the legacy Lesson.embedding path and the Knowledge layer
 * (Phase 2F). NOTHING here is invoked by any route yet — this module exists
 * so the backfill strategy is real, reviewable code rather than a design
 * doc, per this phase's explicit instruction not to run a production
 * backfill. The existing Lesson-based tutor (src/lib/ai/search.ts,
 * /api/ai/tutor) is completely unaffected by this file's existence.
 *
 * Design: one KnowledgeSource per Course (type LESSON), one KnowledgeDocument
 * per Lesson, one KnowledgeChunk per document holding a COPY of the lesson's
 * existing embedding (not regenerated — same model/dimension, so copying is
 * safe and free). Lesson.knowledgeDocumentId is set to link them, matching
 * the FK already added in Phase 1. Lesson.embedding itself is left
 * completely untouched — this is additive, not a migration off it.
 *
 * A lesson whose course has no tenantId (Course.tenantId is nullable — a
 * FREE-plan solo course) has no tenant to backfill into, since every
 * Knowledge model requires one. Those lessons are simply not eligible; they
 * keep working exactly as today via the legacy path. Not an error, not
 * fixed here — documented as a permanent gap for tenant-less content.
 *
 * `Lesson.embedding` is an `Unsupported("vector")` column, so Prisma's typed
 * query builder can't filter or select it at all — every check against it
 * below goes through $queryRaw, mirroring src/lib/ai/search.ts.
 */

export type LessonBackfillPlan = {
  tenantId: string;
  eligibleLessonCount: number;
  alreadyBridgedCount: number;
  ineligibleNoTenantCount: number;
};

/** Read-only. Computes what a backfill run would do, without writing anything. */
export async function planLessonBackfill(ctx: KnowledgeAccessContext): Promise<LessonBackfillPlan> {
  const [eligibleRows, alreadyBridged, ineligibleRows] = await Promise.all([
    db.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count
      FROM "Lesson" l
      JOIN "Section" s ON s.id = l."sectionId"
      JOIN "Course" c ON c.id = s."courseId"
      WHERE l.embedding IS NOT NULL
        AND l."knowledgeDocumentId" IS NULL
        AND c."tenantId" = ${ctx.tenantId}
    `,
    db.lesson.count({
      where: {
        knowledgeDocumentId: { not: null },
        section: { course: { tenantId: ctx.tenantId } },
      },
    }),
    db.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count
      FROM "Lesson" l
      JOIN "Section" s ON s.id = l."sectionId"
      JOIN "Course" c ON c.id = s."courseId"
      WHERE l.embedding IS NOT NULL
        AND l."knowledgeDocumentId" IS NULL
        AND c."tenantId" IS NULL
    `,
  ]);

  return {
    tenantId: ctx.tenantId,
    eligibleLessonCount: Number(eligibleRows[0]?.count ?? 0),
    alreadyBridgedCount: alreadyBridged,
    ineligibleNoTenantCount: Number(ineligibleRows[0]?.count ?? 0),
  };
}

/**
 * Backfills ONE lesson into the Knowledge layer by copying its existing
 * embedding. Idempotent (a lesson with knowledgeDocumentId already set is a
 * no-op). Not called by any route/cron/migration — a future ops task would
 * loop this over planLessonBackfill's eligible set, deliberately outside
 * this phase's scope.
 */
export async function backfillLesson(
  ctx: KnowledgeAccessContext,
  lessonId: string
): Promise<{ knowledgeDocumentId: string } | { skipped: string }> {
  const lesson = await db.lesson.findUnique({
    where: { id: lessonId },
    select: {
      id: true,
      title: true,
      description: true,
      textContent: true,
      knowledgeDocumentId: true,
      section: { select: { course: { select: { id: true, tenantId: true, title: true } } } },
    },
  });
  if (!lesson) return { skipped: "lesson not found" };
  if (lesson.knowledgeDocumentId) return { knowledgeDocumentId: lesson.knowledgeDocumentId };
  if (!lesson.section.course.tenantId) return { skipped: "course has no tenant" };

  assertSameTenant(ctx.tenantId, [{ tenantId: lesson.section.course.tenantId, label: "Course" }]);

  let source = await db.knowledgeSource.findFirst({
    where: { tenantId: ctx.tenantId, type: "LESSON", externalId: lesson.section.course.id },
  });
  if (!source) {
    source = await db.knowledgeSource.create({
      data: {
        tenantId: ctx.tenantId,
        type: "LESSON",
        name: `Lessons — ${lesson.section.course.title}`,
        externalId: lesson.section.course.id,
      },
    });
  }

  const document = await db.knowledgeDocument.create({
    data: {
      tenantId: ctx.tenantId,
      sourceId: source.id,
      title: lesson.title,
      textContent: [lesson.title, lesson.description, lesson.textContent]
        .filter(Boolean)
        .join("\n\n"),
      status: "PROCESSING",
      visibility: "TENANT",
    },
  });

  const chunk = await db.knowledgeChunk.create({
    data: {
      tenantId: ctx.tenantId,
      documentId: document.id,
      content: document.textContent ?? "",
      chunkIndex: 0,
      version: 1,
      metadata: { bridgedFromLessonId: lesson.id },
    },
  });

  // Copy the existing Lesson.embedding verbatim — same model/dimension, so
  // no re-embedding call is needed or made.
  await db.$executeRaw`
    UPDATE "KnowledgeChunk" k
    SET embedding = l.embedding
    FROM "Lesson" l
    WHERE k.id = ${chunk.id} AND l.id = ${lesson.id}
  `;

  await db.$transaction([
    db.knowledgeDocument.update({
      where: { id: document.id },
      data: { activeVersion: 1, status: "READY" },
    }),
    db.lesson.update({
      where: { id: lesson.id },
      data: { knowledgeDocumentId: document.id },
    }),
  ]);

  return { knowledgeDocumentId: document.id };
}
