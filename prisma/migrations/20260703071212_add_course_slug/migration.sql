-- AlterTable: add nullable slug column first so existing rows can be backfilled
ALTER TABLE "Course" ADD COLUMN "slug" TEXT;

-- Backfill: derive a slug from each course's title, de-duplicating collisions
-- deterministically (oldest id wins the bare slug, later rows get -2, -3, ...).
WITH base AS (
  SELECT id,
    lower(regexp_replace(regexp_replace(trim(title), '[^a-zA-Z0-9]+', '-', 'g'), '(^-|-$)', '', 'g')) AS base_slug
  FROM "Course"
),
ranked AS (
  SELECT id, base_slug,
    row_number() OVER (PARTITION BY base_slug ORDER BY id) AS rn
  FROM base
)
UPDATE "Course" c
SET "slug" = CASE WHEN r.rn = 1 THEN r.base_slug ELSE r.base_slug || '-' || r.rn END
FROM ranked r
WHERE c.id = r.id;

-- AlterTable: now safe to enforce NOT NULL
ALTER TABLE "Course" ALTER COLUMN "slug" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Course_slug_key" ON "Course"("slug");

-- CreateIndex
CREATE INDEX "Course_slug_idx" ON "Course"("slug");
