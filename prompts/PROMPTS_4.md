# PROMPTS_4.md — Phase 4: AI Features

> Phase 4 tasks must use Opus-class model (not Sonnet) — architecture is complex.
> BEFORE STARTING 4B: Run "CREATE EXTENSION IF NOT EXISTS vector;" on your Neon branch.

---

## Task 4A — Rate Limiting + AI Quota Middleware

```
/start

Read CLAUDE.md, docs/STACK.md, and docs/API.md carefully before writing any code.
This task protects every AI route — get it right before building any AI feature.

1. Create src/lib/redis.ts:
   import { Redis } from "@upstash/redis"
   export const redis = new Redis({
     url: process.env.UPSTASH_REDIS_REST_URL!,
     token: process.env.UPSTASH_REDIS_REST_TOKEN!,
   })

2. Create src/lib/ratelimit.ts with 4 limiters:
   - tutorRatelimit: 10 req/min, prefix "lumio:ai:tutor"
   - quizRatelimit: 5 req/min, prefix "lumio:ai:quiz"
   - summaryRatelimit: 10 req/min, prefix "lumio:ai:summary"
   - pathRatelimit: 2 req/min, prefix "lumio:ai:path"
   All use Ratelimit.slidingWindow.

3. Create src/lib/ai/quota.ts:
   async function checkAndIncrementQuota(userId: string, plan: Plan): Promise<{ allowed: boolean; remaining: number }>
   - Load PLAN_LIMITS[plan].aiCallsPerMonth
   - If limit is Infinity (Enterprise): return { allowed: true, remaining: Infinity }
   - Check User.aiCallsUsed against limit
   - If over: return { allowed: false, remaining: 0 }
   - If allowed: increment User.aiCallsUsed atomically (use Prisma update with increment)
   - Return { allowed: true, remaining: limit - newCount }

4. Create src/lib/ai/middleware.ts:
   Export withAiGuards(userId, limiter) async function that:
   - Checks auth (userId exists)
   - Runs rate limiter → returns 429 if failed
   - Loads user from DB, checks plan quota → returns 403 with upgradeRequired if over
   - Returns { user } if all pass

5. Create src/lib/ai/openai.ts — see STACK.md for exact pattern.

All AI routes in Phase 4 MUST call withAiGuards at the top.

Run npx tsc --noEmit.
Commit: phase/4-task/A: upstash rate limiting and plan quota for all ai routes
```

---

## Task 4B — Vector Embeddings + pgvector Index

```
/start

Read CLAUDE.md and docs/SCHEMA.md before writing any code.

IMPORTANT: Before running prisma migrate, ensure pgvector extension is enabled:
Run in Neon SQL editor: CREATE EXTENSION IF NOT EXISTS vector;

Set up vector embeddings for RAG:

1. Create src/lib/ai/embeddings.ts:
   import { openai } from "@/lib/ai/openai"
   async function generateEmbedding(text: string): Promise<number[]>
   - Uses openai.embedding with model "text-embedding-3-small"
   - Returns array of 1536 floats
   - Input: truncate to 8000 chars if longer (model limit)

2. Create a background embedding job pattern:
   POST /api/ai/embed-lesson/route.ts (internal use, guarded by admin role or internal secret header)
   - Takes lessonId
   - Loads lesson content (textContent or video transcript if available)
   - Generates embedding via generateEmbedding()
   - Stores via raw SQL: db.$executeRaw`UPDATE "Lesson" SET embedding = ${embedding}::vector WHERE id = ${lessonId}`

3. Auto-embed on lesson content save:
   In PUT /api/courses/[courseId]/lessons/[lessonId]:
   After saving textContent changes, trigger embedding in background:
   - Do NOT await it (non-blocking); use setImmediate or a void promise
   - Log errors but don't fail the save request

4. Create src/lib/ai/search.ts:
   async function searchSimilarLessons(query: string, courseId?: string, limit = 3): Promise<Lesson[]>
   - Generate embedding for query
   - Run pgvector similarity search via $queryRaw:
     SELECT id, title, "textContent", 1 - (embedding <=> ${embedding}::vector) AS similarity
     FROM "Lesson"
     WHERE "videoStatus" = 'READY' OR "textContent" IS NOT NULL
     ${courseId ? Prisma.sql`AND "sectionId" IN (SELECT id FROM "Section" WHERE "courseId" = ${courseId})` : Prisma.sql``}
     ORDER BY embedding <=> ${embedding}::vector
     LIMIT ${limit}
   - Return typed Lesson results with similarity score

5. After first migration with vector column, run in Neon SQL editor:
   CREATE INDEX ON "Lesson" USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

Run npx tsc --noEmit.
Commit: phase/4-task/B: pgvector embeddings for lesson content with cosine search
```

---

## Task 4C — AI Tutor (RAG Streaming Chat)

```
/start

Read CLAUDE.md, docs/API.md, and docs/DESIGN_SYSTEM.md before writing any code.
AI Tutor is the flagship AI feature. Build it carefully.

1. Create src/app/api/ai/tutor/route.ts:
   - Call withAiGuards(userId, tutorRatelimit) first
   - Load last 10 UIMessages from AIChat record (or create new AIChat if none)
   - If lessonId provided: call searchSimilarLessons(lastUserMessage, courseId, 3)
     Inject retrieved content into system prompt as context
   - System prompt (from src/lib/ai/prompts.ts):
     "You are an AI tutor for Lumio, an online learning platform.
      Help students understand course material clearly and concisely.
      Use the following course content as context: [RETRIEVED_CONTENT]
      Be encouraging, precise, and ask clarifying questions when needed."
   - Call streamText from "ai" with gpt-4o-mini model
   - After stream completes: save updated UIMessage[] to AIChat.messages
   - Return streaming response using AI SDK v6 stream format

2. Create src/lib/ai/prompts.ts:
   Export TUTOR_SYSTEM_PROMPT, QUIZ_SYSTEM_PROMPT, SUMMARY_SYSTEM_PROMPT
   Each as a function that takes context and returns the full system prompt string.

3. Create src/components/ai/AiTutorChat.tsx (client component):
   - Use useChat() hook from "ai/react"
   - Chat messages list with scrollable container
   - User messages: right-aligned, brand blue bubble
   - AI messages: left-aligned, gray bubble with purple ✦ AI avatar
   - Input: text area + send button
   - Typing indicator: animated dots when isLoading
   - Show AiBadge in the chat header: "✦ AI Tutor"
   - Props: { lessonId?: string, chatId?: string, courseId?: string }

4. Wire AI Tutor into course player:
   Replace "AI Tutor" placeholder tab in PROMPTS_2.md task 2D
   with the real AiTutorChat component.
   Pass lessonId and courseId from the lesson page params.

5. Create standalone AI Tutor page:
   src/app/(student)/ai-tutor/page.tsx
   Full-page chat without lesson context — for general learning questions.

Run npx tsc --noEmit.
Commit: phase/4-task/C: ai tutor with rag streaming chat in course player
```

---

## Task 4D — AI Quiz Generation

```
/start

Read CLAUDE.md and docs/API.md before writing any code.

Build AI quiz generation for instructors:

1. Create src/app/api/ai/quiz/route.ts:
   - Call withAiGuards(userId, quizRatelimit) — yes, instructors also use quota
   - Load Lesson by lessonId (verify instructor owns the course)
   - Build content string from textContent + mux transcript if available
   - Use generateObject from "ai" with gpt-4o model
   - Zod schema for output:
     z.object({
       questions: z.array(z.object({
         question: z.string(),
         type: z.enum(["MCQ", "TRUE_FALSE"]),
         options: z.array(z.object({ id: z.string(), text: z.string() })).optional(),
         correctAnswer: z.string(),
         explanation: z.string(),
       })).length(5),
     })
   - After generation: create Quiz + QuizQuestion[] with isAiGenerated: true
   - Return { quiz, questions }

2. Wire into course builder:
   Replace the Phase 2 "AI Outline" placeholder button.
   Clicking "✦ Generate Quiz":
   - Show loading state (purple spinner)
   - Call /api/ai/quiz
   - Show generated questions in a preview modal
   - "Approve & Save" button: confirm saves to DB and shows quiz in lesson list
   - "Regenerate" button: calls API again
   - "Edit" allows modifying questions before saving

3. AI quiz badge in student view:
   Quizzes with isAiGenerated: true show "✦ AI-generated" badge
   in the course player lesson list and on the quiz start screen.

Run npx tsc --noEmit.
Commit: phase/4-task/D: ai quiz generation with structured output and instructor preview
```

---

## Task 4E — AI Lesson Summary + Learning Path

```
/start

Read CLAUDE.md and docs/API.md before writing any code.

Build AI lesson summary and personalised learning path:

1. Create src/app/api/ai/summary/route.ts:
   - Call withAiGuards(userId, summaryRatelimit)
   - Check Lesson.aiSummary — if exists, return cached (DO NOT call LLM again)
   - Build content from Lesson.textContent (or placeholder if video-only)
   - Use generateText with gpt-4o-mini
   - Prompt: "Summarise this lesson in exactly 3 concise bullet points.
     Each bullet: one clear takeaway a student should remember.
     Return ONLY the 3 bullets, no preamble."
   - Save to Lesson.aiSummary
   - Return { summary: string }

2. Display in course player Notes tab:
   - "AI Summary" section at top of Notes tab with AiBadge
   - Fetch on tab open if not already loaded
   - Below it: student's personal notes (Tiptap editor)
   - Summary is read-only; personal notes are editable

3. Create src/app/api/ai/learning-path/route.ts:
   - Call withAiGuards(userId, pathRatelimit)
   - Load student's: last 20 LessonProgress records, last 10 QuizAttempt scores,
     all Enrollment records with completion %
   - Build context string: "Student completed X% of Course A, scored Y% on quizzes"
   - Use generateObject with gpt-4o and Zod schema:
     z.object({
       recommendations: z.array(z.object({
         lessonId: z.string(),
         reason: z.string(),
         priority: z.enum(["HIGH", "MEDIUM", "LOW"]),
       })).max(5),
       summary: z.string(),
     })
   - Return recommendations

4. Create src/app/(student)/learning-path/page.tsx:
   - "Generate my learning path" button (✦ purple)
   - Shows recommendations in priority order: HIGH first
   - Each recommendation: lesson title, course, reason, "Start Lesson →" link
   - "Regenerate" button (costs 1 AI call)
   - AiBadge in page header
   - Purple AI card for path summary text

Run npx tsc --noEmit.
Commit: phase/4-task/E: ai lesson summary and personalised learning path
```
