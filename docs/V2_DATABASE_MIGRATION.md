# V2 Database Migration — Phase 1 (Foundation)

Status: **generated, not applied**. This document describes the migration in
`prisma/migrations/20260909180000_add_v2_capability_knowledge_ai_foundation/migration.sql`.

## 1. Current schema (before this migration)

`prisma/schema.prisma` as of the last committed state before this change: 22 models covering
identity/auth (`User`, `Tenant`, `Team`, `TeamMember`, `Invitation`, `Notification`,
`OrgRequest`), courses (`Course`, `Section`, `Lesson`), enrollment/progress (`Enrollment`,
`LessonProgress`), quizzes/assignments, gamification (`XPTransaction`, `Certificate`), a single
`AIChat` (JSON message blob), org admin (`MandatoryTraining`), and super admin
(`AdminAuditLog`). 4 prior migrations, latest `20260710220000_add_notification_and_org_request`.

## 2. V2 additions (this migration)

**9 new enums**: `SkillProficiency`, `SkillStatus`, `EvidenceType`, `EvidenceVerificationStatus`,
`KnowledgeSourceType`, `KnowledgeStatus`, `AIConversationType`, `AIExecutionStatus`,
`LearningEventType`.

**18 new tables**:
- Capability: `SkillCategory`, `Skill`, `JobRole`, `RoleSkill`, `UserJobRole`, `UserSkill`,
  `SkillEvidence`, `CourseSkill`.
- Knowledge: `KnowledgeSource`, `KnowledgeDocument`, `KnowledgeChunk` (embedding column via
  `Unsupported("vector(1536)")`, same as the existing `Lesson.embedding`).
- AI: `AIConversation`, `AIMessage`, `AIToolCall`, `AISourceCitation`, `AIExecution`,
  `AIUsageEvent`.
- Events: `LearningEvent`.

**49 new indexes** (tenant-scope, tenant+time, tenant+user, unique tenant-scoped slugs, FK lookup
indexes, plus `@@unique([documentId, chunkIndex])` on `KnowledgeChunk` added during the Phase 1
audit — see migration SQL for the full list).

**1 change to an existing table**: `Lesson` gets one new nullable column,
`knowledgeDocumentId TEXT`, with `FOREIGN KEY ... REFERENCES "KnowledgeDocument"("id") ON DELETE
SET NULL ON UPDATE CASCADE`. `User`, `Tenant`, and `Course` get **zero** column changes — their
new V2 fields are relation arrays only (the FK/join columns live on the child tables:
`UserSkill.userId`, `SkillCategory.tenantId`, `CourseSkill.courseId`, etc.), so Prisma emits no
`ALTER TABLE` for the parent side.

## 3. Migration order

Single migration, applied as one file. Postgres enum types are created first, then tables in
dependency order (parents before children — e.g. `SkillCategory` before `Skill`, `Skill` before
`RoleSkill`/`UserSkill`/`SkillEvidence`/`CourseSkill`), then indexes, then foreign keys last.
This is Prisma's default ordering for a single-file diff and requires no manual sequencing.

## 4. Data backfill strategy

**None required for this migration.** Every new table is empty by construction (no prior data
exists for concepts that didn't exist before), every new FK is nullable (`knowledgeDocumentId`)
or lives on a brand-new table, and no existing row needs new default values. Backfill becomes
relevant in later phases when, per `docs/V2_DOMAIN_MODEL.md` migration strategy steps 2-7 (e.g.
backfilling tenant relationships, mapping each `Course` to a learning program, re-indexing lesson
content into `KnowledgeChunk`) — none of that is in scope for Phase 1.

## 5. Compatibility strategy

- No existing table is dropped, renamed, or has a column dropped/renamed.
- No existing column's type, nullability, or default changes.
- No existing unique/foreign-key constraint is altered.
- `Course -> Section -> Lesson`, `AIChat`, `User.aiCallsUsed`, and `Enrollment`/`LessonProgress`
  are untouched and continue to work exactly as before — verified by re-running `tsc --noEmit`
  and `biome check` against the full existing codebase after the schema change (both pass with
  zero new errors from this change).
- Every new tenant-owned table requires a `tenantId` at the database level (`NOT NULL` FK to
  `Tenant`) except `RoleSkill` and `CourseSkill`, which inherit tenant scope through their parent
  (`JobRole`/`Course`) rather than duplicating the column — documented inline in
  `prisma/schema.prisma`.

## 6. Rollback considerations

Because every change is additive (new types/tables/indexes/one nullable column), rollback is a
plain reverse migration: drop the 18 new tables (children before parents, or `CASCADE`), drop the
`Lesson.knowledgeDocumentId` column and its FK, drop the 9 new enum types. No existing data is at
risk either direction since nothing existing was modified in place. Rollback SQL is not
pre-generated in this task — the migration is not applied yet, so there is nothing to roll back
from.

## 7. Future deprecations (not part of this migration)

Per `docs/V2_MIGRATION_MAP.md`:
- `AIChat` (JSON blob) stays until conversations are backfilled into
  `AIConversation`/`AIMessage` and dual-read is validated.
- `Lesson.embedding` stays until lesson content is re-indexed into `KnowledgeChunk` and
  retrieval (`src/lib/ai/search.ts`) moves to the knowledge layer.
- `User.aiCallsUsed` stays as the live quota-check field until quota can be derived from
  `AIUsageEvent`.
- `SkillGap` and `AIAgentRun` were deliberately not added this phase — see
  `docs/V2_MIGRATION_MAP.md`, Phase 1 status note.

## 8. Phase 1 audit (2026-09-10)

A follow-up audit reviewed the schema, migration SQL, and `src/lib/auth/context.ts` before Phase 2
sign-off. Two issues were fixed (both purely additive, table/enum still unpopulated so no data
risk):

- **The generated `migration.sql` had a stray non-SQL line at the top** — a `dotenv` CLI "tip"
  banner from `.env.local` loading got captured into the file when it was first generated via
  shell redirect (`> migration.sql`). This would have failed with a Postgres syntax error had the
  file been executed as-is. Fixed by regenerating via `prisma migrate diff ... -o migration.sql`
  (Prisma's own file-output flag, which writes the SQL directly and doesn't pick up stdout
  banners) instead of a shell redirect. Verified byte-for-byte identical SQL content otherwise.
- **`KnowledgeChunk` had no constraint preventing two chunks of the same document sharing a
  `chunkIndex`.** Added `@@unique([documentId, chunkIndex])` — a real ordering-corruption risk on
  re-index, purely additive, zero existing rows affected.

Two gaps were found and reported (not fixed — would go beyond the field lists the models were
explicitly scoped to this phase):
- `RoleSkill`, `UserJobRole`, `UserSkill`, `SkillEvidence`, `CourseSkill`, `KnowledgeDocument`,
  `KnowledgeChunk`, and every AI table with parallel FKs (e.g. `AIConversation.tenantId` +
  `.userId`) have **no database-level check that sibling foreign keys agree on tenant** (e.g.
  nothing stops a `RoleSkill` pairing a `JobRole` from tenant A with a `Skill` from tenant B).
  Enforcement is application-level only, consistent with how the *existing* V1 schema already
  works (e.g. `MandatoryTraining.courseId`/`teamId`/`tenantId` has the same property) — not a
  regression, but worth a deliberate service-layer check when Phase 2 domain services are built.
- `LearningEventType` and `AIUsageEvent`/`AIExecution` have no idempotency/dedup key — a retried
  event emitter could double-write. No emitters exist yet, so this wasn't added speculatively;
  flag for when the first emitter is wired up.

Full findings, including several Low-severity/informational items, are in the audit report
delivered alongside this document.

---

## How this SQL was generated (and why Neon was never touched)

`prisma migrate dev` and `prisma migrate diff --from-migrations` both require a live/shadow
database connection to compute state. Per this task's constraint, neither ran against the real
Neon `DATABASE_URL`. Instead:

```bash
git show HEAD:prisma/schema.prisma > /tmp/schema_before.prisma
npx prisma migrate diff \
  --from-schema /tmp/schema_before.prisma \
  --to-schema prisma/schema.prisma \
  --script -o migration.sql
```

(`-o` — Prisma's own file-output flag — not a shell `>` redirect; see §8, the redirect form is
what let a CLI banner leak into the first version of this file.)

This is a pure schema-to-schema diff — no database connection of any kind, read or write. The
resulting SQL was copied into a normal migration folder
(`prisma/migrations/20260909180000_add_v2_capability_knowledge_ai_foundation/migration.sql`) so
it's staged in the standard Prisma migration history format, ready for `prisma migrate deploy` (or
review + `prisma migrate resolve`) once approved — but Prisma has not recorded it as applied
anywhere, because it never connected to a database to do so.

`npx prisma generate` was run to regenerate the local TypeScript client (`src/generated/prisma`)
so the new models type-check — this is local codegen only and does not touch any database.
