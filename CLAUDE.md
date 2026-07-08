# CLAUDE.md — Lumio

> Read this file in full at the start of every session. No exceptions.

---

## Product Identity

**Product:** Lumio — AI-integrated Learning Management System (SaaS)
**Tagline:** Learn with intelligence.
**Domain:** lumio.io (pending purchase)
**Design system:** Structured Light
**Status:** Pre-build. MVP target: 8 weeks.

---

## Package Manager

**pnpm — always. Never npm, never yarn.**

```bash
pnpm install                  # install deps
pnpm dev                      # dev server (Turbopack is default in Next.js 16)
pnpm build                    # production build
pnpm biome check .            # lint
pnpm biome format --write .   # format
npx tsc --noEmit              # type check — run before EVERY commit, no exceptions
prisma migrate dev            # run migrations (reads prisma.config.ts)
prisma generate               # regenerate client after schema changes
```

> **ESLint is not used — Biome handles lint + format.**

---

## Node.js Requirement

**Node.js ≥ 20.9 — hard requirement for Next.js 16.**
Node 18 is dropped. Verify with `node -v` before starting any session.

---

## Tech Stack

| Layer              | Technology                 | Version       | Notes                                                       |
| ------------------ | -------------------------- | ------------- | ----------------------------------------------------------- |
| Framework          | Next.js                    | ^16.2.7       | App Router, `src/` dir, `@/` alias                          |
| Language           | TypeScript                 | ^5.1+         | Strict mode always                                          |
| Styling            | Tailwind CSS               | ^4.3.1        | v4 — config lives in `globals.css` only                     |
| Auth               | Clerk                      | ^7.5.7        | `auth()` is async; middleware at `src/proxy.ts`             |
| Database           | Neon PostgreSQL + pgvector | —             | Via Prisma adapter                                          |
| ORM                | Prisma                     | ^7.x          | Requires `prisma.config.ts` at root                         |
| Animation          | Motion                     | ^12.41.0      | Package: `motion`; import from `"motion/react"`             |
| Payments           | Razorpay                   | ^2.9.x        | India SaaS — NOT Stripe                                     |
| Video              | Mux                        | ^14.1.1       | `@mux/mux-node`                                             |
| AI SDK             | Vercel AI SDK              | ^7.0.2        | `ai` package; `UIMessage`/`ModelMessage` are separate types |
| AI SDK (React)     | `@ai-sdk/react`            | ^4.0.9        | `useChat` imports from here — NOT `ai/react`                |
| AI Provider        | OpenAI                     | ^4.x          | `@ai-sdk/openai`                                            |
| Email              | Resend                     | ^4.x          | `resend` package                                            |
| File Upload        | Uploadthing                | ^7.x          | Route handler in `src/app/api/uploadthing/`                 |
| Redis / Rate limit | Upstash Redis + Ratelimit  | ^1.x / ^2.x   | AI routes must be rate-limited                              |
| Icons              | Lucide React               | latest        | Brand icons: use `simple-icons` package                     |
| UI Components      | shadcn/ui + Radix UI       | latest        |                                                             |
| Forms              | React Hook Form + Zod      | latest / ^3.x | Zod imported from `"zod"` (v3 stable)                       |
| Rich Text          | Tiptap                     | ^2.x          | `@tiptap/react` + `@tiptap/starter-kit`                     |
| Charts             | Recharts                   | ^2.x          | Client components only                                      |
| Scroll             | Lenis                      | ^1.x          | Smooth scroll wrapper                                       |
| Error tracking     | Sentry                     | ^9.x          | `@sentry/nextjs`                                            |
| Deployment         | Vercel                     | —             |                                                             |

---

## CRITICAL: Breaking Changes & Rules

### 1. Tailwind v4 — NO tailwind.config.ts

```
❌ DO NOT create tailwind.config.ts or tailwind.config.js
✅ ALL configuration lives in src/app/globals.css via @theme {}
✅ PostCSS config references @tailwindcss/postcss (not tailwindcss)
```

### 2. Clerk v7 — middleware is src/proxy.ts

```
❌ DO NOT create middleware.ts at any level
✅ Clerk middleware lives at src/proxy.ts ONLY
✅ auth() is async: const { userId } = await auth()
✅ clerkClient() is async: const client = await clerkClient()
✅ Import server-side from @clerk/nextjs/server
```

### 3. Prisma 7 — requires prisma.config.ts

```
✅ prisma.config.ts exists at root (not inside prisma/)
✅ generator block uses provider = "prisma-client"
✅ pgvector requires previewFeatures = ["postgresqlExtensions"]
✅ Run "CREATE EXTENSION IF NOT EXISTS vector;" on Neon before first migration
```

### 4. Motion (formerly Framer Motion)

```
✅ Package name: motion
✅ Client import: import { motion, AnimatePresence } from "motion/react"
✅ Inside RSC files: import * as motion from "motion/react-client"
❌ DO NOT install or import from framer-motion
```

### 5. Razorpay (not Stripe)

```
✅ Server: import Razorpay from "razorpay"
✅ Client: load checkout.js dynamically — no npm package on client
✅ Webhook route: /api/webhooks/razorpay
✅ No Customer Portal — plan management is built natively in Lumio
✅ Signature verification required on EVERY webhook
```

### 6. AI SDK v7

```
✅ Core package: ai (^7.0.2)
✅ UIMessage[] for client/chat state; ModelMessage[] for LLM calls
✅ Use streamText() for AI tutor streaming responses
✅ useChat imports from "@ai-sdk/react" — NOT "ai/react"
✅ convertToModelMessages() is async — must be awaited
✅ toUIMessageStreamResponse is deprecated — use toUIMessageStream + createUIMessageStreamResponse
✅ onFinish renamed to onEnd in streaming helpers
⚠️ generateObject is soft-deprecated — prefer generateText + output (deferred to Phase 6F cleanup)
✅ Every AI route MUST have Upstash rate limiting before calling LLM
✅ Every AI route MUST check user's quota (plan limit) before calling LLM
```

### 7. Next.js 16 specifics

```
✅ Turbopack is default — no --turbopack flag needed in scripts
✅ serverExternalPackages is top-level in next.config.ts (not experimental)
✅ Cache is explicit (opt-in) — nothing is cached by default
✅ params in page/layout props are async: await params
```

---

## Project Structure

```
lumio/
├── CLAUDE.md                          ← you are here
├── AGENTS.md                          ← Vercel AI DevTools MCP context
├── prisma.config.ts                   ← Prisma 7 CLI config (root level)
├── prisma/
│   ├── schema.prisma
│   └── seed.ts
├── next.config.ts
├── postcss.config.mjs                 ← references @tailwindcss/postcss
├── tsconfig.json
├── package.json
├── docs/
│   ├── PHASES.md
│   ├── STACK.md
│   ├── DESIGN_SYSTEM.md
│   ├── SCHEMA.md
│   └── API.md
├── prompts/
│   ├── PROMPTS_1.md
│   ├── PROMPTS_2.md
│   ├── PROMPTS_3.md
│   ├── PROMPTS_4.md
│   ├── PROMPTS_5.md
│   └── PROMPTS_6.md
├── public/
│   └── fonts/
└── src/
    ├── proxy.ts                       ← Clerk middleware (Next.js 16 name)
    ├── app/
    │   ├── globals.css                ← Tailwind v4 @theme config lives here
    │   ├── layout.tsx                 ← root layout, ClerkProvider, fonts
    │   ├── page.tsx                   ← marketing homepage (single page: hero, audience
    │   │                                showcase, capabilities, pricing, FAQ, all in one)
    │   ├── (auth)/                    ← Clerk auth pages
    │   │   ├── sign-in/[[...sign-in]]/page.tsx
    │   │   └── sign-up/[[...sign-up]]/page.tsx
    │   ├── (student)/                 ← student-facing app, all under /
    │   │   ├── layout.tsx
    │   │   ├── dashboard/page.tsx
    │   │   ├── courses/
    │   │   │   ├── page.tsx
    │   │   │   └── [courseId]/
    │   │   │       ├── page.tsx
    │   │   │       └── lessons/[lessonId]/page.tsx
    │   │   ├── learning-path/page.tsx
    │   │   ├── ai-tutor/page.tsx
    │   │   ├── assignments/page.tsx
    │   │   ├── leaderboard/page.tsx
    │   │   └── settings/page.tsx
    │   ├── (instructor)/              ← instructor app, all under /instructor/*
    │   │   │                            (prefixed to avoid colliding with the
    │   │   │                             student group's bare /dashboard, /courses)
    │   │   ├── layout.tsx
    │   │   ├── instructor/
    │   │   │   ├── dashboard/page.tsx
    │   │   │   ├── courses/page.tsx
    │   │   │   └── students/page.tsx
    │   │   ├── courses/
    │   │   │   ├── new/page.tsx
    │   │   │   └── [courseId]/
    │   │   │       ├── edit/page.tsx
    │   │   │       ├── settings/page.tsx
    │   │   │       └── analytics/page.tsx
    │   │   └── students/page.tsx      ← redirect stub → /instructor/students
    │   │                                (earnings/page.tsx: deferred, not built —
    │   │                                 no nav link, no payment-ledger model to back it)
    │   ├── (org)/                     ← org admin app, all under /org/* (except
    │   │   │                            /reports, which predates the /org/* prefix)
    │   │   ├── layout.tsx
    │   │   ├── org/
    │   │   │   ├── dashboard/page.tsx
    │   │   │   ├── teams/page.tsx
    │   │   │   ├── courses/page.tsx
    │   │   │   └── settings/
    │   │   │       ├── page.tsx
    │   │   │       ├── billing/page.tsx
    │   │   │       ├── branding/page.tsx
    │   │   │       └── sso/page.tsx
    │   │   └── reports/page.tsx
    │   ├── (admin)/                   ← super admin app, all under /admin/*
    │   │   ├── layout.tsx
    │   │   └── admin/
    │   │       ├── dashboard/page.tsx
    │   │       ├── tenants/page.tsx
    │   │       ├── users/page.tsx
    │   │       └── billing/page.tsx
    │   ├── [tenant]/                  ← white-label subdomain routing
    │   │   └── page.tsx
    │   └── api/
    │       ├── webhooks/
    │       │   ├── clerk/route.ts
    │       │   └── razorpay/route.ts
    │       ├── uploadthing/
    │       │   ├── core.ts
    │       │   └── route.ts
    │       ├── courses/
    │       │   ├── route.ts
    │       │   └── [courseId]/
    │       │       ├── route.ts
    │       │       └── lessons/route.ts
    │       ├── ai/
    │       │   ├── tutor/route.ts      ← rate-limited, quota-checked
    │       │   ├── quiz/route.ts
    │       │   ├── summary/route.ts
    │       │   └── learning-path/route.ts
    │       ├── billing/
    │       │   ├── create-subscription/route.ts
    │       │   ├── cancel/route.ts
    │       │   └── change-plan/route.ts
    │       └── mux/
    │           └── webhook/route.ts
    ├── components/
    │   ├── ui/                        ← shadcn/ui components
    │   ├── layout/
    │   │   ├── TopNav.tsx
    │   │   ├── Sidebar.tsx
    │   │   └── MobileNav.tsx
    │   ├── course/
    │   │   ├── CourseCard.tsx
    │   │   ├── CoursePlayer.tsx
    │   │   ├── LessonList.tsx
    │   │   └── VideoPlayer.tsx        ← wraps @mux/mux-player-react
    │   ├── ai/
    │   │   ├── AiTutorChat.tsx        ← purple ✦ indicator, rate limit aware
    │   │   ├── AiQuizGenerator.tsx
    │   │   └── AiLearningPath.tsx
    │   ├── billing/
    │   │   ├── PricingCard.tsx
    │   │   ├── PlanBadge.tsx
    │   │   └── UpgradeModal.tsx
    │   └── shared/
    │       ├── SkeletonCard.tsx
    │       ├── EmptyState.tsx
    │       ├── AiBadge.tsx            ← ✦ purple badge for all AI surfaces
    │       └── ErrorBoundary.tsx
    ├── lib/
    │   ├── db.ts                      ← Prisma client singleton
    │   ├── razorpay.ts                ← Razorpay server instance
    │   ├── mux.ts                     ← Mux client
    │   ├── resend.ts                  ← Resend client
    │   ├── redis.ts                   ← Upstash Redis client
    │   ├── ratelimit.ts               ← Upstash Ratelimit configs
    │   ├── uploadthing.ts             ← UT client
    │   └── ai/
    │       ├── openai.ts              ← @ai-sdk/openai provider
    │       ├── embeddings.ts          ← text-embedding-3-small
    │       └── prompts.ts             ← system prompts for AI tutor
    ├── hooks/
    │   ├── useCurrentUser.ts
    │   ├── usePlan.ts
    │   ├── useAiQuota.ts
    │   └── useRazorpay.ts             ← dynamically loads checkout.js
    ├── types/
    │   └── index.ts                   ← all shared TypeScript types
    ├── constants/
    │   └── plans.ts                   ← PLAN_LIMITS per tier
    └── actions/
        ├── course.actions.ts
        ├── lesson.actions.ts
        ├── ai.actions.ts
        └── billing.actions.ts
```

---

## Path Aliases

```typescript
// tsconfig.json — all imports use @/
"@/*": ["./src/*"]
```

**Never use relative imports like `../../lib/db`. Always use `@/lib/db`.**

---

## Design Tokens (quick reference)

```
Brand blue:    #4F6EF7   (--color-brand)
Brand light:   #EEF1FE   (--color-brand-light)
Brand dark:    #3451D1   (--color-brand-dark)
AI purple:     #7C3AED   (--color-ai) — RESERVED for AI surfaces only
AI bg:         #F5F3FF   (--color-ai-bg)
Foreground:    #0F0F10
Muted text:    #737380
Border:        #E5E5E7
Surface 1:     #FFFFFF
Surface 2:     #FAFAFA
Surface 3:     #F5F5F6
```

**AI rule:** Every AI-generated or AI-powered surface MUST show the ✦ glyph and use `--color-ai` (#7C3AED). No exceptions.

---

## Four Roles & Permission Model

| Role          | Clerk org role    | Access                                     |
| ------------- | ----------------- | ------------------------------------------ |
| `student`     | `org:student`     | Own enrollments, AI tutor (quota-gated)    |
| `instructor`  | `org:instructor`  | Create/edit own courses, student analytics |
| `org_admin`   | `org:admin`       | All org data, billing, branding, team mgmt |
| `super_admin` | (custom metadata) | Platform-wide, all tenants                 |

Role is stored in both Clerk `publicMetadata.role` and Prisma `User.role` enum. Keep them in sync via Clerk webhook.

---

## Plan Limits (src/constants/plans.ts)

```
Free:       0 AI calls/mo, 1 course, 0 orgs
Starter:    50 AI calls/mo, 10 courses, 1 org (up to 10 seats)
Pro:        200 AI calls/mo, unlimited courses, 1 org (up to 100 seats)
Enterprise: Unlimited, custom seats, SSO, custom domain
```

Every AI route: check `User.aiCallsUsed < PLAN_LIMITS[plan].aiCallsPerMonth` BEFORE calling the LLM. Return 403 with upgrade prompt if over limit.

---

## Environment Variables

```bash
# Next.js
NEXT_PUBLIC_APP_URL=

# Clerk
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
CLERK_WEBHOOK_SECRET=
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=/dashboard
NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL=/onboarding

# Database
DATABASE_URL=
DIRECT_URL=                            # for Prisma migrations on Neon

# Razorpay
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
NEXT_PUBLIC_RAZORPAY_KEY_ID=          # safe to expose (public key)
RAZORPAY_PLAN_STARTER=                # plan_xxx ID from Razorpay dashboard
RAZORPAY_PLAN_PRO=
RAZORPAY_PLAN_ENTERPRISE=
RAZORPAY_WEBHOOK_SECRET=

# Mux
MUX_TOKEN_ID=
MUX_TOKEN_SECRET=
MUX_WEBHOOK_SECRET=
NEXT_PUBLIC_MUX_ENV_KEY=

# OpenAI (via Vercel AI SDK)
OPENAI_API_KEY=

# Upstash
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=

# Uploadthing
UPLOADTHING_TOKEN=

# Resend
RESEND_API_KEY=

# Sentry
NEXT_PUBLIC_SENTRY_DSN=
SENTRY_AUTH_TOKEN=

# Cron (Vercel auto-sends this as the Bearer token on scheduled invocations)
CRON_SECRET=
```

---

## Git Workflow

```bash
# Before every commit — no exceptions:
npx tsc --noEmit

# Commit format:
git commit -m "phase/N-task/X: short description"
# e.g. "phase/1-task/3: add Clerk webhook user sync"

# Never commit:
# - console.log in production paths
# - hardcoded secrets or API keys
# - .env file
# - broken TypeScript (tsc must pass)
```

---

## Coding Rules

1. **TypeScript strict mode** — no `any`, no `@ts-ignore` without comment
2. **Server Components by default** — only add `"use client"` when necessary
3. **All async data fetching in Server Components** — no `useEffect` for data
4. **Motion imports** — use `"motion/react"` in client components, `"motion/react-client"` in server files
5. **AI surfaces** — always show ✦ badge with `color-ai` purple; never silent
6. **Skeletons** — every async fetch has a matching skeleton (match real shape)
7. **Empty states** — every empty state has a direct CTA button
8. **Error messages** — specific ("Video failed to upload") not vague ("Something went wrong")
9. **Rate limiting** — every `/api/ai/*` route imports and checks `ratelimit.ts` first line
10. **Quota check** — every `/api/ai/*` route checks plan limits before LLM call
11. **Webhook verification** — every webhook route verifies signature before processing
12. **No Stripe** — Razorpay only. If you see Stripe anywhere, flag it immediately.
13. **No framer-motion** — Motion only. Import from `"motion/react"`.
14. **No tailwind.config.ts** — Tailwind config lives in `globals.css` @theme block only.
15. Going forward for all remaining phases: use shadcn/ui primitives for complex interactive components. Do not hand-roll:
- Dialog / AlertDialog → use shadcn
- DropdownMenu → use shadcn  
- Select → use shadcn
- Sheet → use shadcn
- Tabs → use shadcn
- Tooltip → use shadcn
- Popover → use shadcn
- Command → use shadcn

Install components as needed per phase with:
pnpm dlx shadcn@latest add [component]

Simple components (buttons, cards, badges, inputs already built)
stay as hand-rolled — do not replace them.