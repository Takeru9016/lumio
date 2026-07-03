# PROMPTS_6.md — Phase 6: Billing, White-Label & Production

> Phase 6 tasks 6A, 6B, 6D, 6E, 6G must use Opus-class model.
> Tasks 6C and 6F can use Sonnet.
> 6G (Enterprise SSO) is an Enterprise feature — run it after 6D, before the final 6F audit, or defer post-MVP.

---

## Task 6A — Razorpay Subscription Flow

```
/start

Read CLAUDE.md, docs/STACK.md, and docs/API.md before writing any code.
Pay close attention to the Razorpay section — no Stripe anywhere.

1. Create src/app/api/billing/create-subscription/route.ts:
   Guard: AUTH
   Body: { plan: "STARTER" | "PRO" | "ENTERPRISE", seats?: number }
   - Map plan to Razorpay plan ID from env vars
   - Create subscription: razorpay.subscriptions.create({
       plan_id: PLAN_ID,
       customer_notify: 1,
       quantity: seats ?? 1,
       total_count: 120,   // 10 years — effectively open-ended
       notes: { userId, plan },
     })
   - Store razorpaySubId on User and Tenant
   - Return { subscriptionId: sub.id, razorpayKeyId: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID }

2. Create src/app/api/webhooks/razorpay/route.ts:
   - Verify signature (HMAC SHA256 of raw body using RAZORPAY_WEBHOOK_SECRET)
   - Read raw body as text for verification, then parse as JSON
   - Handle events:
     subscription.activated → User.plan = plan, User.subscriptionStatus = ACTIVE
     subscription.charged → update currentPeriodEnd, reset aiCallsUsed = 0
     subscription.cancelled → set subscriptionStatus = CANCELLED, cancelAtPeriodEnd = false
                              set plan back to FREE on currentPeriodEnd (store in scheduledDowngradeAt)
     payment.failed → subscriptionStatus = PAST_DUE, send Resend dunning email

3. Subscription trigger in billing settings:
   In src/app/(student)/settings/page.tsx, billing section:
   - Current plan display with AiBadge for AI quota remaining
   - "Upgrade to [plan]" button → calls useRazorpay() to open checkout modal
   - Checkout options: { subscription_id, key: NEXT_PUBLIC_RAZORPAY_KEY_ID }
   - On success (razorpay handler): verify signature via POST /api/billing/verify-payment
   - Show success toast; plan badge updates after webhook fires

4. Create src/app/api/billing/verify-payment/route.ts:
   - Body: { razorpay_payment_id, razorpay_subscription_id, razorpay_signature }
   - Verify signature: HMAC SHA256 of "payment_id|subscription_id" using key_secret
   - Return { verified: boolean }

Run npx tsc --noEmit.
Commit: phase/6-task/A: razorpay subscription creation and webhook handler
```

---

## Task 6B — Native Plan Management UI

```
/start

Read CLAUDE.md and docs/API.md before writing any code.
Remember: NO Stripe Customer Portal. Everything is built natively.

1. Create src/app/(org)/settings/billing/page.tsx:
   Load: Tenant plan, seatCount, seatLimit, currentPeriodEnd, subscriptionStatus

   Sections:
   a) Current plan card:
      - Plan name badge, price, renewal date, status
      - AI quota used / limit (progress bar)
      - Seats used / limit (progress bar)

   b) Upgrade/downgrade plan selector:
      - Show all 4 plans as cards (Free, Starter, Pro, Enterprise)
      - Current plan highlighted
      - "Switch to this plan" button on other plans

   c) Cancel subscription section:
      - "Cancel subscription" button → confirmation modal
      - Modal: warns plan reverts to Free on [currentPeriodEnd]
      - On confirm → POST /api/billing/cancel
      - If already cancelled: show "Reactivate" button → POST /api/billing/reactivate

2. Create src/app/api/billing/change-plan/route.ts:
   Guard: ORG_ADMIN
   Body: { newPlan: Plan }
   - Load tenant's razorpaySubId
   - Call razorpay.subscriptions.update(subId, { plan_id: NEW_PLAN_ID })
   - Update Tenant.plan and User.plan for all org members
   - Return { success: true, effectiveDate }
   Note: Razorpay applies plan change at next billing cycle by default.

3. Create src/app/api/billing/cancel/route.ts:
   Guard: ORG_ADMIN
   - razorpay.subscriptions.cancel(subId, { cancel_at_cycle_end: 1 })
   - Set User.cancelAtPeriodEnd = true
   - Return { success: true, cancellationDate: currentPeriodEnd }

4. Create src/app/api/billing/reactivate/route.ts:
   Guard: ORG_ADMIN
   - razorpay.subscriptions.pending(subId) — resume if in grace period
   - Reset User.cancelAtPeriodEnd = false
   - Return { success: true }

Run npx tsc --noEmit.
Commit: phase/6-task/B: native plan management ui with upgrade downgrade and cancel
```

---

## Task 6C — Feature Gating

```
/start

Read CLAUDE.md and src/constants/plans.ts before writing any code.

Wire plan limits to actual UI and API enforcement:

1. Create src/components/billing/UpgradeModal.tsx:
   - Modal triggered when user hits a plan limit
   - Props: { feature: string, requiredPlan: Plan, onClose: () => void }
   - Content: "You've reached your [feature] limit on the [plan] plan"
   - Shows next plan benefits briefly
   - "Upgrade to [plan]" CTA → links to /settings/billing
   - Dismiss button

2. Gate AI features:
   - In AiTutorChat: before sending, check usePlan().canUseAI
     If false: show UpgradeModal instead of opening chat
   - Show remaining AI calls in course player AI Tutor tab header
   - When quota hits 0: grey out AI Tutor button with "Upgrade for more AI" label

3. Gate seat addition:
   - In team management (5D), disable "Add member" button when seatCount >= seatLimit
   - Show seat count warning badge when > 80% full

4. Gate Enterprise features in settings:
   - SSO settings page: show lock icon + "Enterprise plan required" overlay for non-Enterprise
   - Custom domain field in branding: same overlay
   - These overlays should be non-dismissible and link to billing page

5. Gate instructor course creation:
   - FREE plan: max 1 course — disable "Create course" button with upgrade tooltip
   - STARTER: max 10 courses — same

Run npx tsc --noEmit.
Commit: phase/6-task/C: feature gating with upgrade prompts and plan limit enforcement
```

---

## Task 6D — White-Label CSS Injection + Branding

```
/start

Read CLAUDE.md and docs/DESIGN_SYSTEM.md before writing any code.

Build the white-label branding system:

1. Create src/app/(org)/settings/branding/page.tsx:
   - Logo upload: Uploadthing thumbnailUploader (image only, max 2MB)
   - Primary colour picker: HTML colour input + hex text input
   - Preview panel: shows how sidebar + buttons + badges look with selected colour
   - Save → PATCH /api/org/branding → updates Tenant.brandColor, Tenant.logoUrl
   - Changes apply immediately (preview) and on next page load (CSS injection)

2. Create CSS injection helper src/lib/tenant-css.ts:
   function getTenantCss(tenant: { id: string, brandColor?: string | null }): string
   - Returns empty string if no brandColor
   - Calculates light/dark variants (simple: add 20% lightness for light, subtract 15% for dark)
     Use a lightweight hex manipulation (no extra package needed — simple math)
   - Returns CSS string: `:root[data-tenant="${id}"] { --color-brand: ...; --color-brand-light: ...; --color-brand-dark: ...; }`

3. Apply in org layout:
   In src/app/(org)/layout.tsx:
   - Load tenant (from subdomain or user's tenantId)
   - Generate tenantCss = getTenantCss(tenant)
   - In JSX: <html data-tenant={tenant.id}>
   - In <head>: {tenantCss && <style dangerouslySetInnerHTML={{ __html: tenantCss }} />}

4. Logo swap:
   - In org layout's TopNav, if Tenant.logoUrl exists, show tenant logo instead of "lumio" wordmark
   - Maintain same height (28px), preserve aspect ratio

Run npx tsc --noEmit.
Commit: phase/6-task/D: white-label css injection with per-tenant brand color and logo
```

---

## Task 6E — Multi-Tenant Subdomain Routing

```
/start

Read CLAUDE.md carefully. Subdomain routing is complex — build it step by step.

1. Update src/proxy.ts:
   After Clerk middleware, add subdomain detection:
   - Get host: request.headers.get("host") ?? ""
   - Extract subdomain: strip ".lumio.io" and "www"
   - If subdomain exists and is not "www" or "app":
     Look up Tenant by subdomain in DB (cache in Redis with 5min TTL)
     If found: inject tenantId as header "x-tenant-id" for use in Server Components
     If not found: redirect to lumio.io/not-found
   - If no subdomain (lumio.io or localhost): no tenant injection

2. Create src/lib/tenant.ts:
   async function getTenantFromHeaders(headers: Headers): Promise<Tenant | null>
   - Reads "x-tenant-id" header set by proxy.ts
   - Loads from DB (or Redis cache)
   - Returns null if not a tenant request

3. Create src/app/[tenant]/page.tsx:
   - White-labeled landing page for tenant subdomain
   - Shows tenant logo, name, featured courses
   - Sign in button leads to Clerk sign-in (with tenant context)

4. Local development workaround:
   - Subdomain routing won't work on localhost
   - Add middleware check: if host === "localhost:3000", read ?tenant= query param instead
   - Document this in a comment in proxy.ts

5. Vercel setup (document in a comment):
   - Add wildcard domain *.lumio.io in Vercel project settings
   - Vercel automatically routes all subdomains to the deployment
   - No per-subdomain configuration needed

Run npx tsc --noEmit.
Commit: phase/6-task/E: multi-tenant subdomain routing in proxy.ts with vercel wildcard
```

---

## Task 6F — Production Readiness

```
/start

Read CLAUDE.md before writing any code.
This is the final task. Do a full audit before starting.

1. Sentry setup:
   Run: pnpm dlx @sentry/wizard@latest -i nextjs
   This auto-configures Sentry with Next.js 16. Follow the prompts.
   Ensure NEXT_PUBLIC_SENTRY_DSN and SENTRY_AUTH_TOKEN are in env.

2. Create src/components/shared/ErrorBoundary.tsx:
   Client component wrapping React error boundary.
   Props: { children, fallback?: React.ReactNode }
   Default fallback: branded error card with "Something went wrong" and "Try again" button.
   Wrap all major layout sections in their respective layout.tsx files.

3. Resend email templates (create src/lib/emails/):
   welcome.tsx — welcome email on sign-up
   enrollment.tsx — enrolled in course confirmation
   certificate.tsx — certificate issued with link
   dunning.tsx — payment failed notice
   Each is a React Email component. Send via Resend in the relevant webhook/action.

4. Run full audit:
   - Search codebase for "console.log" in non-debug paths → remove all
   - Search for "framer-motion" imports → should be zero
   - Search for "tailwind.config" references → should be zero
   - Search for "middleware.ts" → should be zero (only proxy.ts)
   - Search for "import Stripe" → should be zero
   - Verify every /api/ai/* route has rate limit + quota check at top
   - Verify every /api/webhooks/* route has signature verification

5. Run: pnpm build
   Fix every TypeScript error and build error before committing.
   A clean build is the only acceptable end state.

6. Final type check: npx tsc --noEmit
   Must show 0 errors.

Commit: phase/6-task/F: sentry, skeletons, empty states, resend emails, production build pass
```

---

## Task 6G — Enterprise SSO (SAML) Configuration

```
/start

Read CLAUDE.md and docs/API.md before writing any code.
This is an Enterprise-only feature. Reuse the 6C plan-gating pattern — do not
build a bespoke gate.

Note on routing: org pages live under /org/* (e.g. /org/settings, /org/settings/billing).
CLAUDE.md's structure lists (org)/settings/sso, but follow the real convention:
build at (org)/org/settings/sso → /org/settings/sso, and add an SSO card to the
existing /org/settings landing page.

1. Create src/app/(org)/org/settings/sso/page.tsx:
   Guard: ORG_ADMIN (redirect non-admins).
   Load: Tenant plan, samlEnabled, samlMetadataUrl.
   - If Tenant.plan !== "ENTERPRISE": render the Enterprise-only lock state
     (reuse UpgradeModal / Enterprise badge from 6C) with a "Contact sales / Upgrade"
     CTA. Do NOT render the config form.
   - If ENTERPRISE: render the SSO config client component.

2. Create src/components/org/SsoSettings.tsx (client):
   - Enable SSO toggle → Tenant.samlEnabled
   - IdP metadata URL input (validate it's a URL; required when enabled)
   - Save → PATCH /api/org/sso
   - Show current connection status; link out to Clerk's SSO setup docs
   - Explain: Clerk owns the SAML connection (Enterprise SSO via Clerk organizations);
     Lumio stores the toggle + metadata URL and defers auth to Clerk.

3. Create src/app/api/org/sso/route.ts:
   Guard: ORG_ADMIN.
   PATCH body: { samlEnabled: boolean, samlMetadataUrl?: string }
   - Reject if tenant plan !== ENTERPRISE (403 with upgrade prompt).
   - If samlEnabled === true, require a valid samlMetadataUrl.
   - Update Tenant.samlEnabled, Tenant.samlMetadataUrl.
   - Return { success: true }.

4. Add an "SSO" card to src/app/(org)/org/settings/page.tsx:
   - Same pattern as the Billing card (icon + label + ChevronRight, links to /org/settings/sso).
   - Show an "Enterprise" badge on the card when Tenant.plan !== ENTERPRISE.

Run npx tsc --noEmit.
Commit: phase/6-task/G: enterprise saml sso configuration page with clerk
```
