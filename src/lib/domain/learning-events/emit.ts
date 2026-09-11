import type { LearningEventType, Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";

export type EmitLearningEventParams = {
  tenantId: string;
  userId: string;
  eventType: LearningEventType;
  entityType: string;
  entityId: string;
  occurredAt: Date;
  metadata?: Record<string, unknown>;
};

/**
 * Writes one LearningEvent row. Deliberately NOT part of the capability
 * evidence transaction (see src/lib/domain/capability/outcomes.ts) — this is
 * the analytics/audit stream, and a failure here must never be able to make
 * capability state (SkillEvidence/UserSkill) incorrect, nor may capability
 * state ever depend on this succeeding. Callers must invoke this AFTER their
 * capability transaction has already committed, wrapped in their own
 * try/catch that logs and swallows any failure (see outcomes.ts) — this
 * function itself does not catch, so a caller that forgets to wrap it will
 * find out immediately in review/tests rather than silently.
 */
export async function emitLearningEvent(params: EmitLearningEventParams): Promise<void> {
  await db.learningEvent.create({
    data: {
      tenantId: params.tenantId,
      userId: params.userId,
      eventType: params.eventType,
      entityType: params.entityType,
      entityId: params.entityId,
      occurredAt: params.occurredAt,
      metadata: params.metadata as Prisma.InputJsonValue | undefined,
    },
  });
}
