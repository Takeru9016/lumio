import type { Course, Lesson, Section } from "@/generated/prisma/client";

/**
 * Learning domain foundation. Phase 1 (docs/V2_MIGRATION_MAP.md) does NOT
 * introduce LearningProgram/Activity — `Course -> Section -> Lesson` stays
 * the canonical model this phase (docs/V2_DOMAIN_MODEL.md, "Learning" says
 * "Retain existing Course/Section/Lesson initially"). This file exists so
 * other V2 domains (capability, knowledge) have a stable import path to the
 * existing learning types without reaching into `@/generated/prisma/client`
 * directly, and as the landing spot for LearningProgram/Activity when that
 * migration is scoped.
 */
export type { Course, Section, Lesson };
