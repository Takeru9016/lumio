# AGENTS.md — Lumio

> This file is read by the Vercel AI DevTools MCP (get_routes tool) and AI coding agents.
> It provides project context so agents understand the app before touching code.

---

## What is Lumio?

Lumio is an AI-integrated Learning Management System (SaaS) built with Next.js 16 App Router.
It supports four roles: student, instructor, org_admin, super_admin.
Authentication is via Clerk v7. Database is Neon PostgreSQL via Prisma 7. Payments are via Razorpay (India).

---

## Key Architectural Facts

- **Middleware lives at `src/proxy.ts`** — not `middleware.ts` (Next.js 16 change)
- **Tailwind config is in `src/app/globals.css`** via `@theme {}` — no `tailwind.config.ts`
- **Animation library is `motion`** — import from `"motion/react"`, NOT from `"framer-motion"`
- **`auth()` from Clerk is async** — always `await auth()`
- **Prisma config is `prisma.config.ts`** at root — not inside `prisma/`
- **AI routes at `/api/ai/*`** are rate-limited via Upstash and quota-checked against plan limits
- **All AI surfaces use purple (#7C3AED) + ✦ glyph** — never render AI content silently

---

## Route Map Summary

### Public routes (no auth)

- `/` — marketing homepage
- `/pricing` — pricing page
- `/sign-in`, `/sign-up` — Clerk auth

### Student routes (requires `org:student` role)

- `/dashboard` — student home with streak, XP, continue learning
- `/courses` — enrolled courses list
- `/courses/[courseId]` — course overview
- `/courses/[courseId]/lessons/[lessonId]` — course player (video + AI tutor + lesson list)
- `/learning-path` — AI-generated learning path
- `/ai-tutor` — standalone AI tutor chat
- `/assignments` — active assignments
- `/leaderboard` — XP leaderboard
- `/settings` — profile, notifications, plan

### Instructor routes (requires `org:instructor` role)

- `/dashboard` — instructor home with revenue, student count
- `/courses` — course management list
- `/courses/new` — create course wizard
- `/courses/[courseId]/edit` — course builder
- `/courses/[courseId]/analytics` — per-course analytics
- `/students` — enrolled student list
- `/earnings` — payout history

### Org Admin routes (requires `org:admin` role)

- `/dashboard` — org overview (completion rate, overdue, certs)
- `/teams` — team management, seat assignment
- `/courses` — course assignment to teams
- `/reports` — compliance and progress reports
- `/settings/billing` — plan management (upgrade/cancel — built natively, no portal redirect)
- `/settings/branding` — logo, colors, custom domain
- `/settings/sso` — SAML SSO config (Enterprise only)

### API routes

- `POST /api/webhooks/clerk` — user sync to DB
- `POST /api/webhooks/razorpay` — subscription events (signature-verified)
- `POST /api/webhooks/mux` — video processing events
- `POST /api/uploadthing` — file uploads
- `GET/POST /api/courses` — course CRUD
- `POST /api/ai/tutor` — streaming AI tutor (rate-limited, quota-checked)
- `POST /api/ai/quiz` — AI quiz generation
- `POST /api/ai/summary` — lesson summary
- `POST /api/ai/learning-path` — personalised path generation
- `POST /api/billing/create-subscription` — Razorpay subscription creation
- `POST /api/billing/cancel` — cancel subscription
- `POST /api/billing/change-plan` — upgrade/downgrade plan

---

## Environment Setup

Ensure these are set in `.env.local` before running:

```
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
CLERK_SECRET_KEY
DATABASE_URL
DIRECT_URL
RAZORPAY_KEY_ID
RAZORPAY_KEY_SECRET
NEXT_PUBLIC_RAZORPAY_KEY_ID
OPENAI_API_KEY
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
MUX_TOKEN_ID
MUX_TOKEN_SECRET
UPLOADTHING_TOKEN
RESEND_API_KEY
```

Run `pnpm dev` to start. Turbopack is default in Next.js 16 — no extra flags needed.

---

## Neon pgvector Setup (required before Phase 4)

```sql
-- Run once on your Neon branch before first migration:
CREATE EXTENSION IF NOT EXISTS vector;
```

---

## AI Features Reference

| Feature         | Route                   | Model                  | Rate limit          |
| --------------- | ----------------------- | ---------------------- | ------------------- |
| AI Tutor (chat) | `/api/ai/tutor`         | gpt-4o-mini            | 10 req/min per user |
| Quiz generator  | `/api/ai/quiz`          | gpt-4o                 | 5 req/min per user  |
| Lesson summary  | `/api/ai/summary`       | gpt-4o-mini            | 10 req/min per user |
| Learning path   | `/api/ai/learning-path` | gpt-4o                 | 2 req/min per user  |
| Vector search   | Neon pgvector           | text-embedding-3-small | —                   |
