# PROMPTS_2.md — Phase 2: Course Engine

---

## Task 2A — Mux Video Integration

```
/start

Read CLAUDE.md and docs/API.md before writing any code.

Integrate Mux for video upload and playback:

1. Create src/lib/mux.ts:
   import Mux from "@mux/mux-node"
   export const mux = new Mux({ tokenId: process.env.MUX_TOKEN_ID!, tokenSecret: process.env.MUX_TOKEN_SECRET! })
   Note: @mux/mux-node v14+ uses this constructor pattern — NOT new Mux.Video()

2. Create src/app/api/uploadthing/core.ts:
   - videoUploader: maxFileSize "2GB", allowedFileTypes ["video/mp4", "video/webm"]
     middleware: verify instructor role
     onUploadComplete: create Mux asset from uploaded URL using mux.video.assets.create()
     Store muxAssetId on the Lesson record
   - thumbnailUploader: maxFileSize "4MB", image/*; instructor only
   - assignmentUploader: maxFileSize "32MB", any; student only

3. Create src/app/api/uploadthing/route.ts (Uploadthing v7 pattern):
   import { createRouteHandler } from "uploadthing/next"
   import { ourFileRouter } from "./core"
   export const { GET, POST } = createRouteHandler({ router: ourFileRouter })

4. Create src/app/api/webhooks/mux/route.ts:
   - Verify Mux webhook signature using mux.webhooks.unwrap()
   - Handle video.asset.ready: find Lesson by muxAssetId, update muxPlaybackId and videoStatus = READY
   - Handle video.asset.errored: set videoStatus = ERROR

5. Create src/components/course/VideoPlayer.tsx:
   - Wraps @mux/mux-player-react <MuxPlayer>
   - Props: { playbackId: string, onProgress?: (pct: number) => void, onComplete?: () => void }
   - Shows skeleton (shape-matched) while videoStatus !== READY
   - Fires onComplete when playback reaches 90%
   - Styled: rounded-lg, aspect-video, black background

Run npx tsc --noEmit.
Commit: phase/2-task/A: mux video upload and playback integration
```

---

## Task 2B — Course Builder UI

```
/start

Read CLAUDE.md and docs/DESIGN_SYSTEM.md before writing any code.

Build the instructor course builder:

1. Create src/app/(instructor)/courses/new/page.tsx:
   - Step 1: Basic info (title, description, category, level, price, currency)
   - Step 2: Thumbnail upload (via Uploadthing thumbnailUploader)
   - Step 3: Confirm → create Course via POST /api/courses → redirect to /courses/[courseId]/edit
   - Use React Hook Form + Zod for validation

2. Create src/app/(instructor)/courses/[courseId]/edit/page.tsx:
   - Two-panel layout: left sidebar = course structure tree, right = selected item editor
   - Left sidebar: list of sections with lessons underneath each
   - Add section button, add lesson button per section
   - Each lesson: icon for type (Video, Text, Quiz, Assignment), reorder handle

3. Create src/components/course/LessonList.tsx:
   - Uses @dnd-kit/sortable for drag-to-reorder
   - Sections are draggable; lessons within sections are draggable
   - On reorder: PATCH /api/courses/[courseId]/reorder with new order array
   - Lesson item shows: type icon, title, duration (if video), published status, edit button

4. Lesson editor (right panel) switches based on selected lesson type:
   - VIDEO type: upload area using Uploadthing videoUploader; shows processing spinner when videoStatus = PROCESSING
   - TEXT type: Tiptap rich text editor with starter-kit
   - QUIZ type: placeholder card "Quiz builder coming in Phase 3"
   - ASSIGNMENT type: placeholder card "Assignment builder coming in Phase 3"

5. Create AI Outline button in the course builder toolbar:
   - Purple ✦ button "AI Outline"
   - For now: show a toast "AI outline coming in Phase 4"
   - Wire the button so it's easy to connect to /api/ai/quiz in Phase 4

Run npx tsc --noEmit.
Commit: phase/2-task/B: instructor course builder with drag-reorder sections
```

---

## Task 2C — Course Catalogue + Enrollment

```
/start

Read CLAUDE.md and docs/API.md before writing any code.

Build course browsing and enrollment:

1. Build GET /api/courses route.ts:
   Include: sections count, lessons count, instructor name, enrollment count
   Filter by: status, instructorId, tenantId, category
   Paginate: page + limit query params

2. Build POST /api/courses/[courseId]/enroll/route.ts:
   - Verify student is authenticated
   - Check not already enrolled (return 409 if so)
   - For paid courses, require razorpayPaymentId (verify via Razorpay API)
   - Create Enrollment record
   - Send Resend welcome email
   - Return enrollment

3. Create src/app/(student)/courses/page.tsx:
   - Grid of enrolled courses + available courses
   - Filter bar: All, In Progress, Completed
   - Uses CourseCard component

4. Create src/components/course/CourseCard.tsx:
   - Thumbnail (aspect-video), title, instructor, category badge
   - Progress bar if enrolled (from LessonProgress)
   - AI badge (purple ✦) if course has AI-generated content
   - Price display for unenrolled; "Continue" button for enrolled
   - Hover: subtle lift animation using motion from "motion/react"

5. Create src/app/(student)/courses/[courseId]/page.tsx:
   - Course overview: thumbnail, title, description, instructor, curriculum list
   - Curriculum: sections + lessons list (locked if not enrolled)
   - Enroll button (or Continue if enrolled)
   - Free lesson preview: isFree lessons show "Preview" badge

Run npx tsc --noEmit.
Commit: phase/2-task/C: course catalogue with enrollment flow
```

---

## Task 2D — Course Player

```
/start

Read CLAUDE.md and docs/DESIGN_SYSTEM.md before writing any code.

Build the course player — the most important screen in Lumio:

Layout (from DESIGN_SYSTEM.md):
- Full-width video area at top
- Below video: tabs (Notes, Discussion, AI Tutor [placeholder], Resources)
- Right sidebar (240px): lesson list with sections, completion indicators
- Top bar: "← Back to course", course title, "Lesson N of M", progress bar

1. Create src/app/(student)/courses/[courseId]/lessons/[lessonId]/page.tsx
   - Verify enrollment before showing content (redirect to course page if not enrolled)
   - Load lesson data server-side

2. VideoPlayer integration:
   - Show VideoPlayer (from Phase 2A) for VIDEO type lessons
   - Show Tiptap read-only view for TEXT type lessons
   - On 90% watch: call POST /api/courses/[courseId]/lessons/[lessonId]/complete
   - Show confetti or XP toast when lesson completes

3. Right sidebar (LessonList):
   - Group by section with section headers
   - Completion indicator: ✓ green circle = complete, blue ring = current, grey ring = incomplete
   - AI quiz items: purple ✦ icon, "(AI)" label
   - Click lesson → navigate to that lesson URL

4. Tab panel below video:
   - Notes: Tiptap editor (student personal notes, save to localStorage for now)
   - Discussion: placeholder "Discussion coming soon"
   - AI Tutor: placeholder card with ✦ purple styling "AI Tutor coming in Phase 4"
   - Resources: lesson attachments list

5. Progress bar in top bar:
   - Percentage = completedLessons / totalLessons × 100
   - Updates optimistically on lesson complete

Run npx tsc --noEmit.
Commit: phase/2-task/D: course player with video, lesson list, progress tracking
```

---

## Task 2E — Course Publication

```
/start

Read CLAUDE.md and docs/API.md before writing any code.

Build course publication flow:

1. Create POST /api/courses/[courseId]/publish/route.ts:
   Guard: instructor must own the course.
   Pre-publish checklist validation:
   - Title: not empty, not "Untitled Course"
   - Description: minimum 100 characters
   - Thumbnail: must be set
   - At least 1 section
   - At least 1 lesson in each section
   - At least 1 lesson must have videoStatus = READY
   Return 400 with { errors: string[] } if checklist fails.
   On success: set status = PUBLISHED, publishedAt = now()

2. Add publish UI in course builder:
   - "Publish" button in top bar (disabled if status = PUBLISHED)
   - On click: run checklist via API, show error list if fails
   - On success: show success toast, update status badge

3. Status badge in course list:
   - DRAFT: grey badge
   - PUBLISHED: green badge
   - ARCHIVED: amber badge

4. Archived courses: add Archive action in course settings menu.
   Archived courses not visible to new students; existing enrollments continue.

Run npx tsc --noEmit.
Commit: phase/2-task/E: course publish flow with pre-publish checklist
```
