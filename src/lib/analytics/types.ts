import type { LearningEvent, LearningEventType } from "@/generated/prisma/client";

/**
 * Type-only foundation for the analytics/events domain (see
 * docs/V2_DOMAIN_MODEL.md, "Analytics and evidence"). `LearningEvent` is
 * append-only history; it does not replace operational state tables like
 * `LessonProgress`/`Enrollment`. No event-emission helper yet — first
 * emitters get added when a learner workflow actually needs them (Phase 3,
 * docs/V2_MIGRATION_MAP.md).
 */
export type { LearningEvent, LearningEventType };

export type LearningEventInput = {
  tenantId: string;
  userId: string;
  eventType: LearningEventType;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown>;
};
