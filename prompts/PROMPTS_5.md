# PROMPTS_5.md — Phase 5: Dashboards, Analytics & Org Admin

---

## Task 5A — Student Dashboard

```
/start

Read CLAUDE.md and docs/DESIGN_SYSTEM.md before writing any code.

Build the student dashboard — the first thing students see after login:

1. Create src/app/(student)/dashboard/page.tsx (Server Component):
   Load server-side:
   - User with xpTotal, currentStreak, aiCallsUsed, plan
   - Last 3 enrollments sorted by lastAccessed (in-progress only)
   - Weekly XP from XPTransaction records (last 7 days)

2. Layout (matches the UI/UX spec from the design review):
   - Greeting: "Good morning, [name]" (time-aware)
   - Streak indicator: 🔥 N-day streak (only if streak >= 2)
   - Stats row: 3 cards — Enrolled courses, Avg completion %, XP this week
   - "Continue learning" section: last 3 courses with mini progress bars
   - AI learning path card (purple ✦): "Your path was updated — 3 new lessons"
     Links to /learning-path. Shows date of last path generation.
   - All data states must have matching skeletons

3. Animate page entry:
   Use motion from "motion/react" — stagger stats cards, then continue learning row.
   Keep it subtle: 0.15s duration, easeOut, y: 6 → 0.

4. Empty state (no enrollments):
   Show EmptyState component with "Explore Courses →" CTA button.

Run npx tsc --noEmit.
Commit: phase/5-task/A: student dashboard with stats, continue learning, streak
```

---

## Task 5B — Instructor Analytics

```
/start

Read CLAUDE.md before writing any code.

Build instructor course analytics:

1. Create GET /api/courses/[courseId]/analytics/route.ts:
   Guard: instructor must own the course.
   Returns:
   - totalEnrollments, completionRate (%), avgQuizScore (%)
   - enrollmentsByDay: [{date, count}] for last 30 days (for chart)
   - lessonDropoff: [{lessonId, title, completedCount, totalEnrolled}] sorted by order
   - topStudents: [{userId, name, progress, lastActive}] top 10 by progress

2. Create src/app/(instructor)/courses/[courseId]/analytics/page.tsx:
   - Enrollment chart: Recharts LineChart, enrollments over last 30 days
     (Recharts is client-only — wrap in "use client" component)
   - Summary cards: enrollments, completion rate, avg quiz score
   - Lesson drop-off table: shows where students stop progressing
     Highlight lessons with < 50% completion in amber
   - Student list: progress bar per student, last active date

3. Navigation:
   Add "Analytics" tab to course builder top nav.

Run npx tsc --noEmit.
Commit: phase/5-task/B: instructor course analytics with recharts and student list
```

---

## Task 5C — Org Admin Dashboard

```
/start

Read CLAUDE.md and docs/DESIGN_SYSTEM.md before writing any code.

Build the org admin dashboard:

1. Create src/app/(org)/dashboard/page.tsx (Server Component):
   Load:
   - Tenant with seatCount, seatLimit, plan
   - Active members count (User records with tenantId, excluding cancelled)
   - Overall completion rate across all courses × all members
   - Overdue mandatory trainings (dueDate < now, completedCount < totalMembers)
   - Certs issued in last 30 days

2. Layout:
   - Stats row (4 cards): Active Members, Completion Rate, Overdue Training count (red if > 0), Certs Issued
   - Overdue training alert card (amber): "N members haven't completed [course]"
     "Send nudge" button → POST /api/org/nudge — sends Resend email to all overdue members
   - AI Skills Gap card (purple ✦): "Skills gap report ready" → links to /reports
     (The AI analysis will be added in a later enhancement; for now show static card with link)
   - Seat usage bar: N of M seats used; "Add seats" link if near limit

3. Nudge endpoint:
   Create POST /api/org/nudge/route.ts:
   - Load all members who haven't completed the specified mandatory training
   - Send Resend email to each: "Reminder: [course] is due [date]"
   - Return { sent: number }

Run npx tsc --noEmit.
Commit: phase/5-task/C: org admin dashboard with overdue alerts and ai skills gap card
```

---

## Task 5D — Team Management + Mandatory Training

```
/start

Read CLAUDE.md and docs/SCHEMA.md before writing any code.

Build team management and mandatory training:

1. Create src/app/(org)/teams/page.tsx:
   - List of teams with member count
   - Create team modal: name input → POST /api/org/teams
   - Team detail panel (or modal): list of members with role badge
   - Add member: search users by email → POST /api/org/teams/[teamId]/members
   - Remove member button with confirm dialog
   - Seat limit enforcement: disable "Add member" if seatCount >= seatLimit

2. Create org team API routes:
   GET /api/org/teams → list tenant's teams
   POST /api/org/teams → create team
   POST /api/org/teams/[teamId]/members → add user to team (check seat limit)
   DELETE /api/org/teams/[teamId]/members/[userId] → remove from team

3. Mandatory training:
   In src/app/(org)/courses/page.tsx:
   - List available courses (tenant's courses + marketplace courses)
   - "Assign as mandatory" button → opens modal:
     Select team, set due date → POST /api/org/mandatory-training
   - Assigned courses show "Mandatory for [team]" badge
   - Due date display with countdown if < 7 days

4. Overdue detection:
   In the org dashboard (5C), query:
   MandatoryTraining where dueDate < now AND completedCount < team member count
   This is what drives the amber alert card.

Run npx tsc --noEmit.
Commit: phase/5-task/D: team management with mandatory training assignment and overdue tracking
```

---

## Task 5E — Compliance Reports

```
/start

Read CLAUDE.md before writing any code.

Build org compliance reporting:

1. Create src/app/(org)/reports/page.tsx:
   Three tabs: Completion Report, Certificate Log, Skills Gap (✦ AI — placeholder for future)

2. Completion report tab:
   - Filters: Team, Course, Date range
   - Table: Member name, Course, % complete, Last active, Status (Completed/In Progress/Not Started)
   - "Export CSV" button → generates and downloads CSV client-side

3. Certificate log tab:
   - Table: Member name, Course, Issue date, Certificate ID
   - "Download cert" link per row

4. CSV export:
   Create src/lib/export.ts:
   function generateCSV(headers: string[], rows: string[][]): string
   function downloadCSV(filename: string, csv: string): void (client-side, triggers download)

5. GET /api/org/reports/completion route:
   - Query params: teamId?, courseId?, from?, to?
   - Returns flattened completion data per member per course

Run npx tsc --noEmit.
Commit: phase/5-task/E: org compliance reports with csv export
```
