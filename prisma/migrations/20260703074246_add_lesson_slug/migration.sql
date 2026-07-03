-- AlterTable: add nullable slug column first so existing rows can be backfilled
ALTER TABLE "Lesson" ADD COLUMN "slug" TEXT;

-- Backfill: derive a slug from each lesson's title, de-duplicating collisions
-- within the same section deterministically (oldest id wins the bare slug).
WITH base AS (
  SELECT id, "sectionId",
    lower(regexp_replace(regexp_replace(trim(title), '[^a-zA-Z0-9]+', '-', 'g'), '(^-|-$)', '', 'g')) AS base_slug
  FROM "Lesson"
),
ranked AS (
  SELECT id, "sectionId", base_slug,
    row_number() OVER (PARTITION BY "sectionId", base_slug ORDER BY id) AS rn
  FROM base
)
UPDATE "Lesson" l
SET "slug" = CASE WHEN r.rn = 1 THEN r.base_slug ELSE r.base_slug || '-' || r.rn END
FROM ranked r
WHERE l.id = r.id;

-- AlterTable: now safe to enforce NOT NULL
ALTER TABLE "Lesson" ALTER COLUMN "slug" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Lesson_sectionId_slug_key" ON "Lesson"("sectionId", "slug");

-- CreateIndex
CREATE INDEX "Lesson_slug_idx" ON "Lesson"("slug");
