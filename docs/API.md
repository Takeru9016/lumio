# API.md — Lumio Route Reference

> Every API route. Auth guard, rate limit, and shape defined.
> Claude Code reads this before building any route to avoid inventing endpoints.

---

## Auth Guard Levels

| Level         | Meaning                         |
| ------------- | ------------------------------- |
| `PUBLIC`      | No auth required                |
| `AUTH`        | Any authenticated user          |
| `STUDENT`     | `role === STUDENT`              |
| `INSTRUCTOR`  | `role === INSTRUCTOR`           |
| `ORG_ADMIN`   | `role === ORG_ADMIN`            |
| `SUPER_ADMIN` | `role === SUPER_ADMIN`          |
| `OWNER`       | Auth + resource ownership check |

---

## Webhook Routes (always PUBLIC — verified by signature)

### POST /api/webhooks/clerk

- Guard: `PUBLIC` (verify `svix-signature` header)
- Handles: `user.created`, `user.updated`, `user.deleted`
- On `user.created`: create `User` record with `clerkId`, `email`, `name`, `avatarUrl`; set `role` from `publicMetadata.role` (default `STUDENT`)
- On `user.updated`: sync email, name, avatarUrl, role
- On `user.deleted`: soft-delete or anonymise user

### POST /api/webhooks/razorpay

- Guard: `PUBLIC` (verify `x-razorpay-signature` header using HMAC SHA256)
- Handles:
  - `subscription.activated` → set `User.subscriptionStatus = ACTIVE`, update `plan`; if the tenant has no current `razorpaySubId` (the downgrade cron clears it for a replacement that had not activated yet), record the event's subscription id on the tenant and the subscriber. A tenant that already has a current subscription id is never overwritten
  - `subscription.charged` → update `currentPeriodEnd`, reset `aiCallsUsed`
  - `subscription.cancelled` → set `subscriptionStatus = CANCELLED`, revert `plan` on `currentPeriodEnd`
  - `payment.failed` → set `subscriptionStatus = PAST_DUE`, send Resend email
- **Signature verification required before any DB write**

### POST /api/webhooks/mux

- Guard: `PUBLIC` (verify Mux webhook secret)
- Handles:
  - `video.asset.ready` → update `Lesson.muxPlaybackId`, `videoStatus = READY`
  - `video.asset.errored` → set `videoStatus = ERROR`

---

## File Upload

### GET /api/uploadthing

### POST /api/uploadthing

- Guard: `AUTH`
- Uploadthing v7 route handler
- Defined in `src/app/api/uploadthing/core.ts`:
  - `videoUploader` — max 2GB, video/mp4, video/webm; instructor only → forwards to Mux
  - `thumbnailUploader` — max 4MB, image/\*; instructor only
  - `assignmentUploader` — max 32MB, any; student only

---

## Course Routes

### POST /api/courses

- Guard: `INSTRUCTOR`
- Body: `{ title, description?, thumbnailUrl?, category?, level?, price?, currency? }`
- Returns: created `Course`

### GET /api/courses/[courseId]

- Guard: `AUTH` (students must be enrolled for full access; public for basic info)
- Returns: `Course` with `sections`, `lessons` (without video URLs if not enrolled)

### PUT /api/courses/[courseId]

- Guard: `OWNER` (instructorId must match)
- Body: any `Course` fields
- Returns: updated `Course`

### DELETE /api/courses/[courseId]

- Guard: `OWNER`
- Only if no enrollments. Returns 409 if enrolled students exist.

### POST /api/courses/[courseId]/enroll

- Guard: `STUDENT`
- Body: `{}` (free courses) or `{ razorpayPaymentId }` (paid)
- Paid courses: the payment must be captured, its `order_id` must resolve to a Razorpay Order for the same amount/currency, and that Order's receipt (and, on orders created since Phase 23, its full `courseId`/`userId` notes) must match this user and course. A payment with no `order_id` is rejected.
- Legacy orders (created before Phase 23) have no notes; their receipt holds the full course id but only a 12-character user-id prefix, so their user binding is a compatibility check, not a strict proof.
- Creates `Enrollment` record; sends welcome email via Resend
- Returns: `Enrollment`

### POST /api/courses/[courseId]/publish

- Guard: `OWNER`
- Validates: title, description, thumbnail, ≥1 section, ≥1 lesson with READY video
- Sets `Course.status = PUBLISHED`, `publishedAt = now()`

---

## Lesson Routes

### GET /api/courses/[courseId]/lessons/[lessonId]

- Guard: `AUTH` + enrollment check (unless `isFree`)
- Returns: full `Lesson` with `muxPlaybackId`, `textContent`, `quiz`, `assignment`

### PUT /api/courses/[courseId]/lessons/[lessonId]

- Guard: `OWNER`
- Body: any `Lesson` fields
- Returns: updated `Lesson`

### POST /api/courses/[courseId]/lessons/[lessonId]/complete

- Guard: `STUDENT` + enrollment check
- Creates or updates `LessonProgress` with `isCompleted: true`, `completedAt: now()`
- Awards XP: +10 for completion, +5 bonus if first attempt
- Returns: `{ xpAwarded, newStreak, lessonProgress }`

---

## AI Routes (all require AUTH + rate limit + quota check)

### POST /api/ai/tutor

- Guard: `AUTH`
- Rate limit: 10 req/min per user (Upstash sliding window)
- Quota: `User.aiCallsUsed < PLAN_LIMITS[plan].aiCallsPerMonth`
- Body: `{ messages: UIMessage[], lessonId?: string, chatId?: string }`
- RAG: if `lessonId`, retrieve top-3 similar lesson chunks via pgvector
- Uses: `streamText` with `gpt-5.4-mini`; streams response
- After success: increment `User.aiCallsUsed`; save updated messages to `AIChat`
- Returns: streaming text response (AI SDK v7 stream)

### POST /api/ai/quiz

- Guard: `INSTRUCTOR` (generates quiz for their lesson)
- Rate limit: 5 req/min per user
- Quota: same check
- Body: `{ lessonId }`
- Uses: `generateObject` with `gpt-5.4` + Zod schema for 5 MCQ questions
- Saves to `Quiz` + `QuizQuestion[]` with `isAiGenerated: true`
- Returns: `{ quiz, questions }`

### POST /api/ai/summary

- Guard: `AUTH`
- Rate limit: 10 req/min per user
- Body: `{ lessonId }` (a non-empty string)
- Entitlement is checked before the cache is read or the model is called:
  - ACTIVE/COMPLETED enrollment → allowed for a published, non-archived lesson in a non-DRAFT course (a `REFUNDED` enrollment grants nothing)
  - No enrollment → a free lesson is allowed only if it and its course are published and the course belongs to the caller's tenant or to no tenant; a visible paid lesson → 403 "Not enrolled in this course"
  - Missing, hidden, unpublished, archived, draft or cross-tenant lessons → identical 404
  - No role shortcut for `INSTRUCTOR`, `ORG_ADMIN` or `SUPER_ADMIN`
- Checks `Lesson.aiSummary` — return cached if exists (don't call LLM twice)
- Uses: `generateText` with `gpt-5.4-mini`
- Saves result to `Lesson.aiSummary`
- Returns: `{ summary }` (3 bullet points)

### POST /api/ai/learning-path

- Guard: `STUDENT`
- Rate limit: 2 req/min per user
- Body: `{ courseId? }` (optional — scoped or platform-wide)
- Gathers: student's `LessonProgress`, `QuizAttempt` scores, `Enrollment` data
- Uses: `generateObject` with `gpt-5.4` + Zod schema
- Returns: `{ recommendations: [{ lessonId, reason, priority }] }`

---

## Billing Routes

### POST /api/billing/create-subscription

- Guard: `ORG_ADMIN` with a tenant (401 unauthenticated, 403 any other role, 400 no organisation)
- Body: `{ plan: "STARTER" | "PRO" | "ENTERPRISE", seats?: number }` — `seats` must be a whole number from 1 to the plan's seat limit (STARTER 10, PRO 100, ENTERPRISE unlimited); invalid plan or seats → 400, never coerced
- The tenant and user come from the session, never from the body
- 409 if the organisation's current subscription is `ACTIVE`, `PAST_DUE` or `PAUSED` (use change-plan); a `CANCELLED` or never-activated subscription may be replaced
- Creates Razorpay subscription using plan ID from env, with notes `{ userId, plan, tenantId }`
- Records `Tenant.razorpaySubId` (compare-and-set) and the caller's `User.razorpaySubId` in one transaction; never changes `plan`, `seatLimit` or subscription status (the webhook does, on activation)
- Replacing a `CANCELLED` subscription leaves the superseded owner's cancellation record untouched; the downgrade cron (`/api/cron/downgrade-subscriptions`) judges it against the tenant's current `razorpaySubId`: a live (`ACTIVE`/`PAST_DUE`/`PAUSED`) replacement keeps the tenant paid, a replacement that never activated is downgraded like any other cancelled subscription
- Losing a concurrent creation race → 409 and the just-created Razorpay subscription is cancelled
- Returns: `{ subscriptionId, razorpayKeyId }` — client opens Razorpay modal

### POST /api/billing/change-plan

- Guard: `ORG_ADMIN`
- Body: `{ newPlan: Plan }`
- Calls Razorpay API to swap subscription plan
- Updates `Tenant.plan` and `User.plan` for all org members
- Returns: `{ success, effectiveDate }`

### POST /api/billing/cancel

- Guard: `ORG_ADMIN`
- Body: `{ immediate?: boolean }`
- Sets `cancelAtPeriodEnd: true` (default) or cancels immediately
- Returns: `{ success, cancellationDate }`

---

## Quiz Routes

### POST /api/quizzes/[quizId]/attempt

- Guard: `STUDENT` + enrollment check
- Body: `{ answers: [{ questionId, answer }] }`
- Scores attempt, saves `QuizAttempt` + `QuizAnswer[]`
- Awards XP: +25 for pass, +50 for perfect score
- Returns: `{ score, isPassed, xpAwarded, correctAnswers }`

---

## Assignment Routes

### POST /api/assignments/[assignmentId]/submit

- Guard: `STUDENT`
- Body: `{ textContent?, fileUrl? }`
- Creates `AssignmentSubmission`
- Awards XP: +15
- Returns: `{ submission }`

### PUT /api/assignments/[assignmentId]/submissions/[submissionId]/grade

- Guard: `INSTRUCTOR` (must own the course) — `STUDENT`, `ORG_ADMIN` and `SUPER_ADMIN` get 403, as does a non-owning instructor. `POST /api/ai/assignments/[assignmentId]/submissions/[submissionId]/suggest-grade` applies the same rule before any AI call
- Body: `{ score, feedback }`
- Updates `AssignmentSubmission.status = GRADED`, sets score and feedback
- Returns: updated submission

---

## Webhook Signature Verification Patterns

### Razorpay webhook

```typescript
import crypto from "crypto";

function verifyRazorpayWebhook(body: string, signature: string): boolean {
  const expected = crypto
    .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET!)
    .update(body)
    .digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
```

### Clerk webhook

```typescript
import { Webhook } from "svix";
// Use svix package — clerk docs use this for webhook verification
```
