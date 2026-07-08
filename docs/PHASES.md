# PHASES.md — Lumio MVP Build Plan

> 6 phases. One sub-phase per session. Commit after every task.
> Check off tasks as completed. Never start the next phase until current is fully committed.

---

## Phase 1 — Foundation & Auth (Week 1–2)

**Goal:** Running app with role-based auth, DB connected, shell layouts for all 4 roles, and Razorpay plans seeded.

### Tasks

- [ ] **1A** — Project scaffold + config files
  - Next.js 16 via `create-next-app@latest`
  - `pnpm` workspace
  - `tsconfig.json` with `@/` alias and strict mode
  - `next.config.ts` with `serverExternalPackages: ["@prisma/client", "prisma"]`
  - `postcss.config.mjs` with `@tailwindcss/postcss`
  - `src/app/globals.css` with full `@theme {}` block (see DESIGN_SYSTEM.md)
  - `src/proxy.ts` — Clerk middleware (public routes: `/`, `/sign-in`, `/sign-up`, `/api/webhooks/*`)
  - `.env.local` template
  - `AGENTS.md` at root
  - **Model:** Sonnet
  - **Commit:** `phase/1-task/A: scaffold next16 project with tailwind v4 and clerk v7`

- [ ] **1B** — Prisma 7 + Neon setup
  - `prisma.config.ts` at root with `defineConfig`
  - `prisma/schema.prisma` — full schema from SCHEMA.md
  - `src/lib/db.ts` — Prisma client singleton (global pattern for Next.js)
  - Run `prisma migrate dev --name init`
  - Run `prisma generate`
  - Verify connection with a test query in a temp route
  - **Model:** Sonnet
  - **Commit:** `phase/1-task/B: add prisma 7 schema and neon connection`

- [ ] **1C** — Clerk auth + user sync webhook
  - `src/app/(auth)/sign-in/[[...sign-in]]/page.tsx`
  - `src/app/(auth)/sign-up/[[...sign-up]]/page.tsx`
  - `src/app/api/webhooks/clerk/route.ts` — sync user create/update/delete to `User` table; set `role` from Clerk `publicMetadata.role`
  - `src/hooks/useCurrentUser.ts` — reads from Clerk + DB
  - Test: create user → verify in DB
  - **Model:** Sonnet
  - **Commit:** `phase/1-task/C: clerk auth with user sync webhook`

- [ ] **1D** — Root layout + font setup
  - `src/app/layout.tsx` — `ClerkProvider`, Space Grotesk + Geist + IBM Plex Mono via `next/font/google`
  - Fonts injected as CSS variables: `--font-heading`, `--font-body`, `--font-mono`
  - `src/components/shared/AiBadge.tsx` — ✦ purple badge component (used everywhere AI is surfaced)
  - **Model:** Sonnet
  - **Commit:** `phase/1-task/D: root layout with fonts and AiBadge component`

- [ ] **1E** — Shell layouts for all 4 roles
  - `src/app/(student)/layout.tsx` — sidebar with student nav items
  - `src/app/(instructor)/layout.tsx` — instructor sidebar
  - `src/app/(org)/layout.tsx` — org admin sidebar
  - `src/app/(admin)/layout.tsx` — super admin sidebar
  - `src/components/layout/TopNav.tsx` — logo, nav links, AI Tutor badge, avatar
  - `src/components/layout/Sidebar.tsx` — collapsible (240px → 64px icon-only)
  - Role guard: redirect to correct layout based on `User.role`
  - **Model:** Sonnet
  - **Commit:** `phase/1-task/E: shell layouts for all 4 roles with sidebar nav`

- [ ] **1F** — Razorpay setup + plan seeding
  - `src/lib/razorpay.ts` — Razorpay server instance
  - Create plans in Razorpay dashboard (manually): Starter, Pro, Enterprise
  - Save plan IDs to `.env.local` as `RAZORPAY_PLAN_STARTER`, `RAZORPAY_PLAN_PRO`, `RAZORPAY_PLAN_ENTERPRISE`
  - `src/constants/plans.ts` — `PLAN_LIMITS` object with AI quota, seat limits, feature flags per tier
  - `src/hooks/useRazorpay.ts` — dynamically loads `checkout.js` from Razorpay CDN
  - **Model:** Opus
  - **Commit:** `phase/1-task/F: razorpay setup with plan constants and checkout hook`

---

## Phase 2 — Course Engine (Week 2–3)

**Goal:** Instructors can create, structure, and publish courses with video. Students can browse and enroll.

### Tasks

- [ ] **2A** — Mux video integration
  - `src/lib/mux.ts` — Mux server client (`new Mux({ tokenId, tokenSecret })`)
  - `src/app/api/mux/webhook/route.ts` — handle `video.asset.ready` and `video.asset.errored`; update `Lesson.muxAssetId`, `muxPlaybackId`, `videoStatus`
  - `src/components/course/VideoPlayer.tsx` — wraps `@mux/mux-player-react`; shows skeleton while loading
  - Uploadthing route for video → forward to Mux; store upload URL
  - **Model:** Opus
  - **Commit:** `phase/2-task/A: mux video upload and playback integration`

- [ ] **2B** — Course builder UI (instructor)
  - `src/app/(instructor)/courses/new/page.tsx` — create course wizard (title, description, thumbnail, category, price)
  - `src/app/(instructor)/courses/[courseId]/edit/page.tsx` — full course builder
  - `src/components/course/LessonList.tsx` — drag-to-reorder sections and lessons (use `@dnd-kit/sortable`)
  - Lesson types: Video, Text (Tiptap), Quiz (placeholder for Phase 3), Assignment (placeholder)
  - AI outline button: calls `/api/ai/quiz` stub (returns placeholder in Phase 2, real in Phase 4)
  - **Model:** Opus
  - **Commit:** `phase/2-task/B: instructor course builder with drag-reorder sections`

- [ ] **2C** — Course catalogue + enrollment
  - `src/app/(student)/courses/page.tsx` — enrolled + available courses grid
  - `src/components/course/CourseCard.tsx` — thumbnail, title, instructor, progress bar, AI badge if AI-gen content
  - `src/app/api/courses/route.ts` — GET (list with filters), POST (create)
  - `src/app/api/courses/[courseId]/route.ts` — GET, PUT, DELETE; check ownership for mutations
  - Enrollment: `POST /api/courses/[courseId]/enroll` — creates `Enrollment` record, sets `status: ACTIVE`
  - **Model:** Sonnet
  - **Commit:** `phase/2-task/C: course catalogue with enrollment flow`

- [ ] **2D** — Course player (student)
  - `src/app/(student)/courses/[courseId]/lessons/[lessonId]/page.tsx` — full player layout
  - Left: VideoPlayer (full width top), tabs below (Notes, Discussion, AI Tutor placeholder, Resources)
  - Right sidebar: lesson list with completion indicators (✓ green, active blue ring, incomplete gray)
  - Progress tracking: mark lesson complete on video 90% watched; update `LessonProgress`
  - Top bar: back link, course title, lesson N of M, progress bar
  - **Model:** Opus
  - **Commit:** `phase/2-task/D: course player with video, lesson list, progress tracking`

- [ ] **2E** — Course publication + publishing guards
  - Instructor publish flow: draft → review checklist → publish
  - Checklist: title, description, thumbnail, at least 1 section, at least 1 lesson with video
  - `Course.status` enum: `DRAFT | PUBLISHED | ARCHIVED`
  - Published courses visible to students; drafts only to instructor
  - **Model:** Sonnet
  - **Commit:** `phase/2-task/E: course publish flow with pre-publish checklist`

---

## Phase 3 — Quizzes, Assignments & Gamification (Week 3–4)

**Goal:** Quizzes (manual + AI-generated), assignments with submission, XP system, streaks, leaderboard.

### Tasks

- [ ] **3A** — Quiz engine
  - `Quiz` and `QuizQuestion` models (from SCHEMA.md)
  - Quiz builder for instructors: add MCQ, true/false, short answer questions
  - Student quiz attempt: `QuizAttempt` + `QuizAnswer` records; calculate score on submit
  - Pass/fail threshold configurable per quiz
  - **Model:** Opus
  - **Commit:** `phase/3-task/A: quiz engine with attempt tracking and scoring`

- [ ] **3B** — Assignment engine
  - Assignment creation (instructor): title, description, due date, attachment
  - Student submission: text + file upload via Uploadthing
  - `AssignmentSubmission` with `status: SUBMITTED | GRADED | LATE`
  - Instructor grading UI: view submission, add score + feedback
  - **Model:** Sonnet
  - **Commit:** `phase/3-task/B: assignment creation, submission, and grading`

- [ ] **3C** — XP system + streaks
  - `src/lib/xp.ts` — `awardXP(userId, action, amount)` function
  - XP events: lesson complete (+10), quiz pass (+25), assignment submit (+15), perfect quiz (+50), daily login (+5)
  - `User.xpTotal`, `User.currentStreak`, `User.lastActiveDate`
  - Streak logic: increment if `lastActiveDate` was yesterday; reset if gap > 1 day
  - Streak display in TopNav (🔥 N-day streak)
  - **Model:** Sonnet
  - **Commit:** `phase/3-task/C: xp system with streak tracking and awards`

- [ ] **3D** — Leaderboard
  - `src/app/(student)/leaderboard/page.tsx`
  - Weekly and all-time leaderboard (top 50 by XP)
  - Highlight current user's rank even if outside top 50
  - Within-org leaderboard for org plans
  - **Model:** Sonnet
  - **Commit:** `phase/3-task/D: xp leaderboard with weekly and all-time views`

- [ ] **3E** — Certificates
  - On course completion (all lessons done + all quizzes passed): generate certificate
  - `Certificate` model with `certificateUrl` (PDF stored in Uploadthing or generated HTML→PDF)
  - Display in student profile; org admin can see all certs issued
  - **Model:** Sonnet
  - **Commit:** `phase/3-task/E: course completion certificate generation`

---

## Phase 4 — AI Features (Week 4–5)

**Goal:** AI tutor (RAG), AI quiz generation, AI lesson summary, AI learning path, pgvector search.

> **Before starting Phase 4:** Run `CREATE EXTENSION IF NOT EXISTS vector;` on your Neon branch.

### Tasks

- [ ] **4A** — Upstash rate limiting + AI quota middleware
  - `src/lib/redis.ts` — Upstash Redis client
  - `src/lib/ratelimit.ts` — per-route limiters (10/min for tutor, 5/min for quiz, 2/min for path)
  - `src/lib/ai/` — `checkAiQuota(userId)` helper: reads `User.aiCallsUsed` + plan limit
  - `incrementAiUsage(userId)` — atomic increment after successful call
  - Apply to all `/api/ai/*` routes
  - **Model:** Opus
  - **Commit:** `phase/4-task/A: upstash rate limiting and plan quota for all ai routes`

- [ ] **4B** — Vector embeddings + pgvector index
  - `src/lib/ai/embeddings.ts` — `generateEmbedding(text)` using `text-embedding-3-small`
  - On lesson content save: generate embedding, store in `Lesson.embedding` (`Unsupported("vector(1536)")`)
  - `src/app/api/ai/search/route.ts` — cosine similarity search via raw Prisma `$queryRaw`
  - pgvector index: `CREATE INDEX ON "Lesson" USING ivfflat (embedding vector_cosine_ops);`
  - **Model:** Opus
  - **Commit:** `phase/4-task/B: pgvector embeddings for lesson content with cosine search`

- [ ] **4C** — AI Tutor (RAG streaming chat)
  - `src/app/api/ai/tutor/route.ts` — streaming route using `streamText` from `ai`
  - RAG: retrieve top-3 similar lesson chunks via pgvector, inject into system prompt
  - Conversation history: load last 10 messages from `AIChat.messages` (`UIMessage[]`)
  - Save updated messages array after each turn
  - `src/components/ai/AiTutorChat.tsx` — streaming chat UI with `useChat` hook; purple ✦ header
  - Wire into course player as "AI Tutor" tab
  - **Model:** Opus
  - **Commit:** `phase/4-task/C: ai tutor with rag streaming chat in course player`

- [ ] **4D** — AI quiz generation
  - `src/app/api/ai/quiz/route.ts` — given `lessonId`, generate 5 MCQ questions using lesson content
  - Use structured output (`Output.object` with Zod schema)
  - Save generated questions to `Quiz` + `QuizQuestion` with `isAiGenerated: true`
  - UI: instructor clicks "✦ Generate Quiz" in course builder → shows preview → confirm to save
  - AI-generated quizzes show purple ✦ badge in student view
  - **Model:** Opus
  - **Commit:** `phase/4-task/D: ai quiz generation with structured output and instructor preview`

- [ ] **4E** — AI lesson summary + learning path
  - `src/app/api/ai/summary/route.ts` — summarise lesson transcript/content into 3 bullet points
  - Show in "Notes" tab of course player with ✦ AI badge
  - `src/app/api/ai/learning-path/route.ts` — analyse student quiz scores + completion; suggest next lessons
  - `src/app/(student)/learning-path/page.tsx` — visual learning path with AI recommendations
  - **Model:** Opus
  - **Commit:** `phase/4-task/E: ai lesson summary and personalised learning path`

---

## Phase 5 — Dashboards, Analytics & Org Admin (Week 5–6)

**Goal:** Student dashboard, instructor analytics, org admin overview, compliance reports, mandatory training.

### Tasks

- [ ] **5A** — Student dashboard
  - `src/app/(student)/dashboard/page.tsx`
  - Stats: enrolled courses, avg completion %, XP this week
  - "Continue learning" — last 3 in-progress courses sorted by `lastAccessed`
  - AI learning path update card (purple, shows when path was last generated)
  - Daily streak card
  - **Model:** Sonnet
  - **Commit:** `phase/5-task/A: student dashboard with stats, continue learning, streak`

- [ ] **5B** — Instructor analytics
  - `src/app/(instructor)/courses/[courseId]/analytics/page.tsx`
  - Metrics: total enrollments, completion rate, avg quiz score, drop-off by lesson
  - Recharts line chart for enrollments over time
  - Student list with individual progress
  - **Model:** Sonnet
  - **Commit:** `phase/5-task/B: instructor course analytics with recharts and student list`

- [ ] **5C** — Org admin dashboard
  - `src/app/(org)/dashboard/page.tsx`
  - Org-wide stats: active members, completion rate, overdue training count, certs issued
  - Overdue training alert card (amber, with "Send nudge" action → Resend email)
  - AI Skills Gap report card (purple ✦, links to `/reports`)
  - **Model:** Opus
  - **Commit:** `phase/5-task/C: org admin dashboard with overdue alerts and ai skills gap card`

- [ ] **5D** — Team management + mandatory training
  - `src/app/(org)/teams/page.tsx` — teams list, add/remove members, assign roles
  - Seat count enforced against `Tenant.seatLimit`
  - Mandatory training: assign course to team with deadline
  - `MandatoryTraining` model: `courseId`, `teamId`, `dueDate`, `completedCount`
  - Auto-flag members as overdue when `dueDate < now` and not completed
  - **Model:** Opus
  - **Commit:** `phase/5-task/D: team management with mandatory training assignment and overdue tracking`

- [ ] **5E** — Compliance reports
  - `src/app/(org)/reports/page.tsx`
  - Export: completion report per course per member (CSV download)
  - Certificate issuance log
  - Filter by team, date range, course
  - **Model:** Sonnet
  - **Commit:** `phase/5-task/E: org compliance reports with csv export`

---

## Phase 6 — Billing, White-Label & Polish (Week 6–8)

**Goal:** Working Razorpay subscription flow, plan gating, white-label CSS injection, multi-tenant subdomain routing, production readiness.

### Tasks

- [ ] **6A** — Razorpay subscription flow
  - `src/app/api/billing/create-subscription/route.ts` — create Razorpay subscription, return `subscription_id`
  - `src/app/(student)/settings/page.tsx` billing section — show current plan, usage, upgrade button
  - `src/hooks/useRazorpay.ts` checkout handler — open Razorpay modal, verify signature on success
  - `src/app/api/webhooks/razorpay/route.ts` — handle `subscription.activated`, `subscription.charged`, `subscription.cancelled`, `payment.failed`; update `User.plan`, `Tenant.plan`
  - **Model:** Opus
  - **Commit:** `phase/6-task/A: razorpay subscription creation and webhook handler`

- [ ] **6B** — Native plan management UI (no portal redirect)
  - `src/app/(org)/settings/billing/page.tsx`
  - Current plan card, seat usage, renewal date, next invoice amount
  - Upgrade/downgrade: `POST /api/billing/change-plan` — Razorpay plan swap via API
  - Cancel flow: confirmation modal → `POST /api/billing/cancel` → sets `cancelAtPeriodEnd: true`
  - Reactivate: available if within grace period
  - **Model:** Opus
  - **Commit:** `phase/6-task/B: native plan management ui with upgrade downgrade and cancel`

- [ ] **6C** — Feature gating
  - `src/hooks/usePlan.ts` — returns `{ plan, limits, isOverLimit }`
  - `src/components/billing/UpgradeModal.tsx` — shown when user hits plan limit
  - Gate AI features: show upgrade prompt if `aiCallsUsed >= limit`
  - Gate seat addition: block if `memberCount >= seatLimit`
  - Gate SSO/custom domain: show Enterprise-only badge on settings page
  - **Model:** Sonnet
  - **Commit:** `phase/6-task/C: feature gating with upgrade prompts and plan limit enforcement`

- [ ] **6D** — White-label CSS injection + branding
  - `src/app/(org)/settings/branding/page.tsx` — logo upload, primary colour picker
  - Store in `Tenant.brandColor`, `Tenant.logoUrl`
  - CSS injection: server-side in org layout, inject `<style>:root[data-tenant="xxx"] { --color-brand: ... }</style>`
  - Apply `data-tenant` attribute to `<html>` tag in org layouts
  - **Model:** Opus
  - **Commit:** `phase/6-task/D: white-label css injection with per-tenant brand color and logo`

- [ ] **6E** — Multi-tenant subdomain routing
  - `src/proxy.ts` — detect subdomain from `request.headers.get("host")`; look up `Tenant` by `subdomain`; inject `tenantId` as request header for downstream use
  - `src/app/[tenant]/page.tsx` — tenant-specific landing page
  - Local dev note: test with query param `?tenant=acme` until real subdomains on Vercel
  - Vercel: add wildcard domain `*.lumio.io` and configure in project settings
  - **Model:** Opus
  - **Commit:** `phase/6-task/E: multi-tenant subdomain routing in proxy.ts with vercel wildcard`

- [ ] **6F** — Production readiness
  - Sentry integration: `@sentry/nextjs` init, error boundaries on all layouts
  - `src/components/shared/ErrorBoundary.tsx`
  - `src/components/shared/SkeletonCard.tsx` — shape-matched skeletons for all major data surfaces
  - `src/components/shared/EmptyState.tsx` — with CTA button
  - Resend: welcome email on sign-up, course enrollment confirmation, certificate issued
  - Run full `pnpm build` — fix all TypeScript and build errors before marking complete
  - **Model:** Sonnet
  - **Commit:** `phase/6-task/F: sentry, skeletons, empty states, resend emails, production build pass`

- [ ] **6G** — Enterprise SSO (SAML) configuration
  - **Ordering:** Enterprise feature — build after 6D (branding) and before the final 6F audit; may be deferred post-MVP. Depends on 6C Enterprise gating.
  - `src/app/(org)/org/settings/sso/page.tsx` — SAML config page (route follows the `/org/*` convention, not the literal `/settings/sso`)
  - Enterprise-gated: if `Tenant.plan !== ENTERPRISE`, show the Enterprise-only lock/upgrade state (reuse 6C gating)
  - Form: IdP metadata URL + enable toggle → stores `Tenant.samlEnabled`, `Tenant.samlMetadataUrl`
  - `PATCH /api/org/sso` (Guard: `ORG_ADMIN`) — validates + persists the SSO config
  - Clerk owns the actual SAML connection (Enterprise SSO via Clerk organizations); this page stores our metadata/toggle and links out to Clerk's SSO setup
  - Add an "SSO" card to `src/app/(org)/org/settings/page.tsx` (same pattern as the Billing card)
  - **Model:** Opus
  - **Commit:** `phase/6-task/G: enterprise saml sso configuration page with clerk`

---

## Checkpoint Tracker (copy into notes)

```
Phase 1: [ ] 1A [ ] 1B [ ] 1C [ ] 1D [ ] 1E [ ] 1F
Phase 2: [ ] 2A [ ] 2B [ ] 2C [ ] 2D [ ] 2E
Phase 3: [ ] 3A [ ] 3B [ ] 3C [ ] 3D [ ] 3E
Phase 4: [ ] 4A [ ] 4B [ ] 4C [ ] 4D [ ] 4E
Phase 5: [ ] 5A [ ] 5B [ ] 5C [ ] 5D [ ] 5E
Phase 6: [ ] 6A [ ] 6B [ ] 6C [ ] 6D [ ] 6E [ ] 6F [ ] 6G
```
