# PROMPTS_3.md — Phase 3: Quizzes, Assignments & Gamification

---

## Task 3A — Quiz Engine

```
/start

Read CLAUDE.md, docs/SCHEMA.md, and docs/API.md before writing any code.

Build the quiz system:

1. Instructor quiz builder (replace Phase 2 placeholder):
   In the lesson editor, QUIZ type now shows a real builder.
   - Add question button: opens modal with question type selector (MCQ, True/False, Short Answer)
   - MCQ: question text + 4 option inputs + "correct answer" radio
   - True/False: question text + correct answer toggle
   - Short Answer: question text + sample answer (graded manually)
   - Drag-to-reorder questions
   - Save: POST /api/courses/[courseId]/lessons/[lessonId]/quiz

2. Create quiz API routes:
   POST /api/courses/[courseId]/lessons/[lessonId]/quiz — create or update quiz
   POST /api/quizzes/[quizId]/attempt — score attempt, save QuizAttempt + QuizAnswer[]

3. Student quiz UI (in course player):
   - Replaces placeholder in QUIZ lesson type
   - Show one question at a time with progress (Q 1 of 5)
   - Multiple choice: radio buttons; True/False: two buttons
   - "Submit" on last question → score immediately for MCQ/TF
   - Show results: score %, pass/fail badge, correct answers revealed
   - Award XP: +25 pass, +50 perfect, show XP toast

4. Quiz attempt history:
   - Student can see past attempts on a quiz
   - Show best score, number of attempts, pass/fail
   - Re-attempt button (no limit for now)

Run npx tsc --noEmit.
Commit: phase/3-task/A: quiz engine with attempt tracking and scoring
```

---

## Task 3B — Assignment Engine

```
/start

Read CLAUDE.md, docs/SCHEMA.md, and docs/API.md before writing any code.

Build the assignment system:

1. Instructor assignment builder (replace Phase 2 placeholder):
   ASSIGNMENT lesson type now shows:
   - Title, description (Tiptap), due date picker, max score
   - Save: creates/updates Assignment record

2. Student assignment view (in course player):
   - Shows assignment brief, due date, max score
   - Text submission area (Tiptap editor)
   - File upload (Uploadthing assignmentUploader, max 32MB)
   - "Submit" button → POST /api/assignments/[assignmentId]/submit
   - After submit: shows submission status badge
   - If past due date: LATE status badge

3. Instructor grading view:
   - In src/app/(instructor)/students/page.tsx, add "Submissions to grade" section
   - List of ungraded submissions sorted by submitted date
   - Click: shows student's submission (text + file download)
   - Score input (0 to maxScore) + feedback text area
   - "Submit grade" → PUT /api/assignments/[assignmentId]/submissions/[id]/grade

4. Student sees grade when it's posted:
   - Score and feedback in course player assignment view
   - Notification in settings page "assignments" tab

Run npx tsc --noEmit.
Commit: phase/3-task/B: assignment creation, submission, and grading
```

---

## Task 3C — XP System + Streaks

```
/start

Read CLAUDE.md and docs/SCHEMA.md before writing any code.

Build the XP and streak system:

1. Create src/lib/xp.ts:
   async function awardXP(userId: string, event: XPEvent, amount: number)
   - Updates User.xpTotal += amount
   - Creates XPTransaction record (add XPTransaction model if not in schema — add it now)
   - Returns new total

   XP events (export as XP_EVENTS constant):
   LESSON_COMPLETE: 10
   QUIZ_PASS: 25
   QUIZ_PERFECT: 50
   ASSIGNMENT_SUBMIT: 15
   DAILY_LOGIN: 5
   COURSE_COMPLETE: 100

2. Create src/lib/streak.ts:
   async function updateStreak(userId: string)
   - Load User.lastActiveDate
   - If today: no change (already active today)
   - If yesterday: increment currentStreak, update lastActiveDate
   - If gap > 1 day: reset currentStreak to 1, update lastActiveDate
   - Update longestStreak if currentStreak > longestStreak

3. Wire into existing events:
   - Lesson complete (/api/courses/.../complete): awardXP + updateStreak
   - Quiz pass (/api/quizzes/[quizId]/attempt): awardXP based on score
   - Assignment submit: awardXP
   - First API call of the day (check via GET /api/me): updateStreak + daily login XP

4. XP toast component (src/components/shared/XpToast.tsx):
   - Shows "+25 XP" with brief animation when XP is awarded
   - Green number, brief slide-up then fade using motion from "motion/react"
   - Triggered by sonner toast

5. Streak display in TopNav:
   - 🔥 N-day text if streak >= 2
   - Hidden if streak is 0 or 1

Run npx tsc --noEmit.
Commit: phase/3-task/C: xp system with streak tracking and awards
```

---

## Task 3D — Leaderboard

```
/start

Read CLAUDE.md and docs/DESIGN_SYSTEM.md before writing any code.

Build the XP leaderboard:

1. Create GET /api/leaderboard/route.ts:
   - Query params: scope ("platform" | "org"), period ("weekly" | "alltime")
   - Weekly: sum XP awarded in last 7 days (from XPTransaction.createdAt)
   - All-time: User.xpTotal
   - Top 50 users, include requesting user's rank even if outside top 50
   - If scope=org: filter by tenantId

2. Create src/app/(student)/leaderboard/page.tsx:
   - Toggle: Weekly / All-Time tabs
   - Toggle: Platform / My Org (only show "My Org" if user is in a tenant)
   - Table: rank, avatar, name, XP, streak
   - Current user row highlighted with brand blue left border
   - Rank 1, 2, 3: gold/silver/bronze badge icons

3. Entry animation:
   - Stagger list items using motion from "motion/react" (see DESIGN_SYSTEM.md pattern)
   - Each row animates in with opacity 0 → 1, y: 8 → 0

Run npx tsc --noEmit.
Commit: phase/3-task/D: xp leaderboard with weekly and all-time views
```

---

## Task 3E — Certificates

```
/start

Read CLAUDE.md and docs/SCHEMA.md before writing any code.

Build course completion certificates:

1. Certificate trigger:
   In /api/courses/[courseId]/lessons/[lessonId]/complete:
   After marking lesson complete, check if ALL lessons in the course are complete
   AND all quizzes in the course have a passing attempt.
   If yes: call generateCertificate(userId, courseId)

2. Create src/lib/certificate.ts:
   async function generateCertificate(userId: string, courseId: string)
   - Load user name and course title
   - Generate HTML certificate template (inline styled, clean design)
   - Certificate includes: student name, course title, completion date, unique cert ID (nanoid)
   - Use Uploadthing to store the HTML as a .html file → get URL
   - Create Certificate record in DB
   - Send congratulations email via Resend with cert link

3. Certificate display in student profile:
   - Add "Certificates" tab to src/app/(student)/settings/page.tsx
   - Grid of earned certificates with course thumbnail, title, date, "View Certificate" link

4. Org admin certificate log:
   - In src/app/(org)/reports/page.tsx, add "Certificates Issued" section
   - Table: student name, course, date, cert ID

Run npx tsc --noEmit.
Commit: phase/3-task/E: course completion certificate generation
```
