# PROMPTS_1.md — Phase 1: Foundation & Auth

> Paste one task prompt per Claude Code session.
> Start every session with /start. End with /check then /commit.

---

## Task 1A — Project Scaffold

```
/start

Read CLAUDE.md and docs/STACK.md in full before writing any code.

Scaffold the Lumio Next.js 16 project with the following:

1. Verify Node.js version is ≥ 20.9. If not, stop and tell me.

2. Create next.config.ts with:
   - serverExternalPackages: ["@prisma/client", "prisma"]
   - images.remotePatterns for Mux, Uploadthing domains

3. Create postcss.config.mjs referencing @tailwindcss/postcss (NOT tailwindcss).
   If a postcss.config.js was auto-generated, delete it and create the .mjs version.

4. Delete tailwind.config.ts if it was created by the scaffold. Config goes in globals.css only.

5. Create src/app/globals.css with the full @theme block from DESIGN_SYSTEM.md.
   Include all colour tokens, font variables, radius, shadow tokens.
   Add the @import "tailwindcss" line at the top.

6. Create tsconfig.json with strict mode, @/ alias pointing to ./src/*, bundler moduleResolution.

7. Create .env.local.example with all env var names from CLAUDE.md (empty values).

8. Create AGENTS.md at project root (copy from lumio-cc/AGENTS.md).

9. Create package.json scripts:
   "dev": "next dev --experimental-https",
   "build": "next build",
   "start": "next start",
   "lint": "next lint",
   "typecheck": "tsc --noEmit"
   Note: no --turbopack flag — it's default in Next.js 16.

Do NOT create any pages or components yet.
Run npx tsc --noEmit after scaffold to confirm zero type errors.

Commit: phase/1-task/A: scaffold next16 project with tailwind v4 and clerk v7
```

---

## Task 1B — Prisma 7 + Neon

```
/start

Read CLAUDE.md and docs/SCHEMA.md in full before writing any code.

Set up Prisma 7 with Neon PostgreSQL:

1. Create prisma.config.ts at the PROJECT ROOT (not inside prisma/).
   Use defineConfig from "prisma/config". Import "dotenv/config" at top.
   Set schema: "prisma/schema.prisma", migrations path: "prisma/migrations",
   datasource url: process.env.DATABASE_URL

2. Create prisma/schema.prisma — paste the FULL schema from SCHEMA.md exactly.
   Do not summarise or omit any model.
   The generator block must use: provider = "prisma-client"
   The datasource block must include directUrl = env("DIRECT_URL")
   The extensions must include: pgvector(map: "vector")

3. Create src/lib/db.ts — Prisma client singleton using globalThis pattern from STACK.md.

4. Install required packages if not already: pnpm add -D prisma && pnpm add @prisma/client

5. Run: prisma generate
   Then: prisma migrate dev --name init
   If migration fails due to pgvector extension, tell me — I need to run
   "CREATE EXTENSION IF NOT EXISTS vector;" on Neon first.

6. Create a temporary GET /api/test/route.ts that queries db.user.count()
   and returns the count. Test it, then delete the file.

Run npx tsc --noEmit. Fix all errors before committing.
Commit: phase/1-task/B: add prisma 7 schema and neon connection
```

---

## Task 1C — Clerk Auth + User Sync Webhook

```
/start

Read CLAUDE.md in full. Pay special attention to the Clerk v7 breaking changes section.

Set up Clerk authentication:

1. Create src/proxy.ts — Clerk middleware for Next.js 16.
   DO NOT create middleware.ts — that is Next.js 15 convention.
   Use clerkMiddleware from @clerk/nextjs/server.
   Public routes: /, /pricing, /about, /sign-in(.*), /sign-up(.*),
   /api/webhooks/(.*), /api/uploadthing(.*)
   All other routes require auth.

2. Create src/app/(auth)/sign-in/[[...sign-in]]/page.tsx — renders <SignIn />
3. Create src/app/(auth)/sign-up/[[...sign-up]]/page.tsx — renders <SignUp />

4. Create src/app/api/webhooks/clerk/route.ts:
   - Verify svix signature using the svix package
   - Handle user.created: create User in DB with clerkId, email, name, avatarUrl,
     role from publicMetadata.role (default STUDENT), plan FREE
   - Handle user.updated: sync email, name, avatarUrl, role changes
   - Handle user.deleted: set a deletedAt timestamp (soft delete)
   - Return 200 with { received: true } on success

5. Create src/hooks/useCurrentUser.ts:
   - Client hook
   - Uses useUser() from @clerk/nextjs to get Clerk user
   - Fetches /api/me for DB user data (create GET /api/me/route.ts that returns
     the DB User record for the authenticated Clerk user)

Remember: auth() is async. Always: const { userId } = await auth()
Remember: import server-side Clerk from @clerk/nextjs/server

Run npx tsc --noEmit. Fix all errors.
Commit: phase/1-task/C: clerk auth with user sync webhook
```

---

## Task 1D — Root Layout + Fonts

```
/start

Read CLAUDE.md and docs/DESIGN_SYSTEM.md before writing any code.

Build the root layout and global font setup:

1. Update src/app/layout.tsx:
   - Import Space_Grotesk, Geist, IBM_Plex_Mono from next/font/google
   - Each font: subsets: ["latin"], display: "swap", variable: "--font-xxx"
   - Space Grotesk weights: ["400", "500", "600", "700"]
   - IBM Plex Mono weights: ["400", "500"]
   - Wrap with <ClerkProvider> from @clerk/nextjs
   - Apply all 3 font variables to <html> className
   - Import globals.css

2. Create src/components/shared/AiBadge.tsx:
   - Props: { label?: string, size?: "sm" | "md" }
   - Renders: ✦ {label} with purple AI styling from DESIGN_SYSTEM.md
   - This component is used on EVERY AI surface — make it clean and reusable

3. Create src/components/shared/EmptyState.tsx:
   - Props: { icon?: string, title, description, ctaLabel?, ctaHref?, onCta? }
   - Centered layout with icon, heading, description, CTA button
   - Uses brand blue button styling from DESIGN_SYSTEM.md

4. Create src/components/shared/SkeletonCard.tsx:
   - Renders an animated pulse skeleton matching a course card shape
   - Props: { count?: number } — renders that many skeletons in a grid

Run npx tsc --noEmit. Fix all errors.
Commit: phase/1-task/D: root layout with fonts and AiBadge component
```

---

## Task 1E — Shell Layouts for All 4 Roles

```
/start

Read CLAUDE.md and docs/DESIGN_SYSTEM.md before writing any code.

Build role-based shell layouts. These are the outer wrappers for each role's app.
NO page content yet — just the nav shells that wrap children.

1. Create src/components/layout/TopNav.tsx:
   - Lumio logo (Space Grotesk Bold, brand blue)
   - Role-specific nav links (passed as prop)
   - Right side: AI Tutor badge (purple ✦), notification bell, user avatar (Clerk UserButton)
   - Height: 52px, border-bottom: 0.5px solid var(--color-border)

2. Create src/components/layout/Sidebar.tsx:
   - Props: { items: NavItem[], role: Role }
   - Expanded: 240px; collapsed: 64px (icon-only)
   - Toggle button to collapse/expand (persist state in localStorage)
   - Active item: brand-light bg, brand blue text, 2px left border
   - Use motion from "motion/react" for smooth width transition
   - Mobile: hidden (replaced by Sheet)

3. Create src/app/(student)/layout.tsx:
   - Nav items: Dashboard, My Courses, Learning Path, AI Tutor, Assignments, Leaderboard, Settings
   - Wrap children with Sidebar + TopNav
   - Role guard: if user.role !== STUDENT, redirect to correct dashboard

4. Create src/app/(instructor)/layout.tsx:
   - Nav items: Dashboard, My Courses, Students, Earnings
   - Role guard: instructor only

5. Create src/app/(org)/layout.tsx:
   - Nav items: Overview, Teams, Courses, Reports, Settings
   - Role guard: org_admin only

6. Create src/app/(admin)/layout.tsx:
   - Nav items: Platform Overview, Tenants, Users, Billing
   - Role guard: super_admin only

7. Create a role-redirect helper:
   - After Clerk sign-in, check User.role and redirect to correct dashboard
   - student → /dashboard, instructor → /dashboard, org_admin → /dashboard, super_admin → /dashboard
   - (Each role's /dashboard will be in their route group)

Run npx tsc --noEmit. Fix all errors.
Commit: phase/1-task/E: shell layouts for all 4 roles with sidebar nav
```

---

## Task 1F — Razorpay Setup + Plan Constants

```
/start

Read CLAUDE.md, docs/STACK.md, and docs/API.md before writing any code.

Set up Razorpay billing foundation:

1. Create src/lib/razorpay.ts:
   import Razorpay from "razorpay"
   export const razorpay = new Razorpay({
     key_id: process.env.RAZORPAY_KEY_ID!,
     key_secret: process.env.RAZORPAY_KEY_SECRET!,
   })
   This is server-only. Never import this in client components.

2. Create src/constants/plans.ts:
   Export PLAN_LIMITS object with per-plan limits:
   FREE: { aiCallsPerMonth: 0, maxCourses: 1, maxSeats: 0, hasCustomDomain: false, hasSSO: false }
   STARTER: { aiCallsPerMonth: 50, maxCourses: 10, maxSeats: 10, hasCustomDomain: false, hasSSO: false }
   PRO: { aiCallsPerMonth: 200, maxCourses: Infinity, maxSeats: 100, hasCustomDomain: true, hasSSO: false }
   ENTERPRISE: { aiCallsPerMonth: Infinity, maxCourses: Infinity, maxSeats: Infinity, hasCustomDomain: true, hasSSO: true }

3. Create src/hooks/useRazorpay.ts (client hook):
   - Dynamically loads https://checkout.razorpay.com/v1/checkout.js via <script> tag
   - Returns { loadRazorpay, isLoading }
   - loadRazorpay() appends script to document.body and resolves when loaded
   - Guard: if already loaded (window.Razorpay exists), resolve immediately

4. Add Razorpay types to src/types/index.ts:
   - RazorpayOptions, RazorpayResponse, RazorpayInstance types
   - Declare global window.Razorpay if TypeScript needs it

5. Create src/hooks/usePlan.ts (client hook):
   - Uses useCurrentUser() to get plan
   - Returns { plan, limits: PLAN_LIMITS[plan], isFreePlan, canUseAI, aiCallsRemaining }

NOTE: Do NOT create Razorpay plans in code — plans must be created manually in the
Razorpay dashboard and their IDs stored as env vars. Document this in a comment.

Run npx tsc --noEmit. Fix all errors.
Commit: phase/1-task/F: razorpay setup with plan constants and checkout hook
```
