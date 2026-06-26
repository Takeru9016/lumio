# SCHEMA.md — Lumio Prisma Schema

> Full schema for `prisma/schema.prisma`. Copy verbatim.
> Run `prisma migrate dev --name init` after pasting.
> Requires: `CREATE EXTENSION IF NOT EXISTS vector;` on Neon before migration.

---

## prisma/schema.prisma

```prisma
generator client {
  provider        = "prisma-client"
  output          = "../src/generated/prisma"
  previewFeatures = ["postgresqlExtensions"]
}

datasource db {
  provider   = "postgresql"
  url        = env("DATABASE_URL")
  directUrl  = env("DIRECT_URL")
  extensions = [pgvector(map: "vector")]
}

// ============================================================
// ENUMS
// ============================================================

enum Role {
  STUDENT
  INSTRUCTOR
  ORG_ADMIN
  SUPER_ADMIN
}

enum Plan {
  FREE
  STARTER
  PRO
  ENTERPRISE
}

enum SubscriptionStatus {
  ACTIVE
  CANCELLED
  PAST_DUE
  PAUSED
}

enum CourseStatus {
  DRAFT
  PUBLISHED
  ARCHIVED
}

enum LessonType {
  VIDEO
  TEXT
  QUIZ
  ASSIGNMENT
}

enum VideoStatus {
  PENDING
  PROCESSING
  READY
  ERROR
}

enum EnrollmentStatus {
  ACTIVE
  COMPLETED
  REFUNDED
}

enum SubmissionStatus {
  SUBMITTED
  GRADED
  LATE
}

// ============================================================
// USER & AUTH
// ============================================================

model User {
  id          String   @id @default(cuid())
  clerkId     String   @unique
  email       String   @unique
  name        String?
  avatarUrl   String?
  role        Role     @default(STUDENT)
  plan        Plan     @default(FREE)

  // AI quota (resets monthly via cron)
  aiCallsUsed    Int      @default(0)
  aiQuotaResetAt DateTime @default(now())

  // Gamification
  xpTotal        Int      @default(0)
  currentStreak  Int      @default(0)
  longestStreak  Int      @default(0)
  lastActiveDate DateTime?

  // Billing (Razorpay)
  razorpayCustomerId   String?
  razorpaySubId        String?
  subscriptionStatus   SubscriptionStatus?
  cancelAtPeriodEnd    Boolean @default(false)
  currentPeriodEnd     DateTime?

  // Relations
  tenantId     String?
  tenant       Tenant?       @relation(fields: [tenantId], references: [id])
  enrollments  Enrollment[]
  courses      Course[]      @relation("InstructorCourses")
  lessonProgress LessonProgress[]
  quizAttempts   QuizAttempt[]
  submissions    AssignmentSubmission[]
  certificates   Certificate[]
  aiChats        AIChat[]
  teamMembers    TeamMember[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([clerkId])
  @@index([tenantId])
  @@index([email])
}

// ============================================================
// MULTI-TENANCY
// ============================================================

model Tenant {
  id          String  @id @default(cuid())
  name        String
  slug        String  @unique  // subdomain: acme → acme.lumio.io
  logoUrl     String?
  brandColor  String? // hex e.g. #1E8A4C
  customDomain String? @unique

  // Plan & billing
  plan          Plan    @default(FREE)
  seatLimit     Int     @default(10)
  seatCount     Int     @default(0)
  razorpaySubId String?

  // SSO (Enterprise only)
  samlEnabled     Boolean @default(false)
  samlMetadataUrl String?

  // Relations
  users     User[]
  teams     Team[]
  courses   Course[]
  mandatoryTrainings MandatoryTraining[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([slug])
}

model Team {
  id       String  @id @default(cuid())
  name     String
  tenantId String
  tenant   Tenant  @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  members  TeamMember[]
  mandatoryTrainings MandatoryTraining[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([tenantId])
}

model TeamMember {
  id     String @id @default(cuid())
  userId String
  teamId String
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)
  team   Team   @relation(fields: [teamId], references: [id], onDelete: Cascade)

  joinedAt DateTime @default(now())

  @@unique([userId, teamId])
  @@index([teamId])
}

// ============================================================
// COURSES
// ============================================================

model Course {
  id           String       @id @default(cuid())
  title        String
  description  String?
  thumbnailUrl String?
  status       CourseStatus @default(DRAFT)
  price        Float        @default(0)
  currency     String       @default("INR")
  category     String?
  level        String?      // Beginner, Intermediate, Advanced

  instructorId String
  instructor   User         @relation("InstructorCourses", fields: [instructorId], references: [id])

  tenantId     String?
  tenant       Tenant?      @relation(fields: [tenantId], references: [id])

  sections     Section[]
  enrollments  Enrollment[]
  mandatoryTrainings MandatoryTraining[]
  certificates Certificate[]

  publishedAt  DateTime?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@index([instructorId])
  @@index([tenantId])
  @@index([status])
}

model Section {
  id       String   @id @default(cuid())
  title    String
  order    Int
  courseId String
  course   Course   @relation(fields: [courseId], references: [id], onDelete: Cascade)

  lessons  Lesson[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([courseId])
}

model Lesson {
  id          String     @id @default(cuid())
  title       String
  description String?
  type        LessonType @default(VIDEO)
  order       Int
  isPublished Boolean    @default(false)
  isFree      Boolean    @default(false)

  // Video (Mux)
  muxAssetId    String?
  muxPlaybackId String?
  videoStatus   VideoStatus @default(PENDING)
  videoDuration Int?        // seconds

  // Text content
  textContent   String?

  // AI embeddings for RAG (pgvector)
  embedding     Unsupported("vector(1536)")?

  sectionId String
  section   Section @relation(fields: [sectionId], references: [id], onDelete: Cascade)

  progress     LessonProgress[]
  quiz         Quiz?
  assignment   Assignment?
  aiChats      AIChat[]
  aiSummary    String?        // cached AI-generated summary

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([sectionId])
}

// ============================================================
// ENROLLMENT & PROGRESS
// ============================================================

model Enrollment {
  id       String           @id @default(cuid())
  status   EnrollmentStatus @default(ACTIVE)
  userId   String
  courseId String
  user     User             @relation(fields: [userId], references: [id])
  course   Course           @relation(fields: [courseId], references: [id])

  completedAt  DateTime?
  lastAccessed DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([userId, courseId])
  @@index([userId])
  @@index([courseId])
}

model LessonProgress {
  id          String  @id @default(cuid())
  isCompleted Boolean @default(false)
  watchedSecs Int     @default(0)

  userId   String
  lessonId String
  user     User   @relation(fields: [userId], references: [id])
  lesson   Lesson @relation(fields: [lessonId], references: [id])

  completedAt DateTime?
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  @@unique([userId, lessonId])
  @@index([userId])
  @@index([lessonId])
}

// ============================================================
// QUIZZES
// ============================================================

model Quiz {
  id              String  @id @default(cuid())
  title           String
  passingScore    Int     @default(70) // percentage
  isAiGenerated   Boolean @default(false)

  lessonId String  @unique
  lesson   Lesson  @relation(fields: [lessonId], references: [id], onDelete: Cascade)

  questions Quiz Question[]
  attempts  QuizAttempt[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model QuizQuestion {
  id            String   @id @default(cuid())
  question      String
  type          String   @default("MCQ") // MCQ | TRUE_FALSE | SHORT_ANSWER
  options       Json?    // array of {id, text} for MCQ
  correctAnswer String   // option id or text
  explanation   String?
  order         Int

  quizId  String
  quiz    Quiz   @relation(fields: [quizId], references: [id], onDelete: Cascade)
  answers QuizAnswer[]

  @@index([quizId])
}

model QuizAttempt {
  id       String @id @default(cuid())
  score    Int    // percentage
  isPassed Boolean
  userId   String
  quizId   String
  user     User   @relation(fields: [userId], references: [id])
  quiz     Quiz   @relation(fields: [quizId], references: [id])

  answers  QuizAnswer[]

  completedAt DateTime @default(now())

  @@index([userId])
  @@index([quizId])
}

model QuizAnswer {
  id         String @id @default(cuid())
  answer     String
  isCorrect  Boolean

  attemptId  String
  questionId String
  attempt    QuizAttempt  @relation(fields: [attemptId], references: [id], onDelete: Cascade)
  question   QuizQuestion @relation(fields: [questionId], references: [id])

  @@index([attemptId])
}

// ============================================================
// ASSIGNMENTS
// ============================================================

model Assignment {
  id          String  @id @default(cuid())
  title       String
  description String
  dueDate     DateTime?
  maxScore    Int      @default(100)

  lessonId String     @unique
  lesson   Lesson     @relation(fields: [lessonId], references: [id], onDelete: Cascade)

  submissions AssignmentSubmission[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model AssignmentSubmission {
  id           String           @id @default(cuid())
  status       SubmissionStatus @default(SUBMITTED)
  textContent  String?
  fileUrl      String?
  score        Int?
  feedback     String?

  userId       String
  assignmentId String
  user         User             @relation(fields: [userId], references: [id])
  assignment   Assignment       @relation(fields: [assignmentId], references: [id])

  submittedAt  DateTime @default(now())
  gradedAt     DateTime?

  @@unique([userId, assignmentId])
  @@index([assignmentId])
}

// ============================================================
// GAMIFICATION
// ============================================================

model Certificate {
  id             String @id @default(cuid())
  certificateUrl String
  userId         String
  courseId       String
  user           User   @relation(fields: [userId], references: [id])
  course         Course @relation(fields: [courseId], references: [id])

  issuedAt DateTime @default(now())

  @@unique([userId, courseId])
  @@index([userId])
}

// ============================================================
// AI
// ============================================================

model AIChat {
  id       String @id @default(cuid())
  messages Json   // UIMessage[] — from Vercel AI SDK v6

  userId   String
  lessonId String?
  user     User    @relation(fields: [userId], references: [id])
  lesson   Lesson? @relation(fields: [lessonId], references: [id])

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([userId])
  @@index([lessonId])
}

// ============================================================
// ORG ADMIN
// ============================================================

model MandatoryTraining {
  id             String   @id @default(cuid())
  dueDate        DateTime
  completedCount Int      @default(0)

  courseId String
  teamId   String
  tenantId String
  course   Course  @relation(fields: [courseId], references: [id])
  team     Team    @relation(fields: [teamId], references: [id])
  tenant   Tenant  @relation(fields: [tenantId], references: [id])

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([courseId, teamId])
  @@index([tenantId])
}
```

---

## prisma/seed.ts

```typescript
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  console.log("Seeding...");

  // Create super admin user (update clerkId after first login)
  await db.user.upsert({
    where: { email: "admin@lumio.io" },
    update: {},
    create: {
      clerkId: "REPLACE_AFTER_FIRST_LOGIN",
      email: "admin@lumio.io",
      name: "Lumio Admin",
      role: "SUPER_ADMIN",
      plan: "ENTERPRISE",
    },
  });

  console.log("Seed complete.");
}

main()
  .catch(console.error)
  .finally(() => db.$disconnect());
```

---

## pgvector Index (run after first migration on Neon)

```sql
-- Run in Neon SQL editor after prisma migrate dev:
CREATE EXTENSION IF NOT EXISTS vector;
CREATE INDEX ON "Lesson" USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

---

## Key Schema Decisions

**Why `messages Json` on AIChat, not individual `AIMessage` rows?**
For MVP, JSON is simpler. The known risk: querying individual messages isn't possible, and large conversations inflate the row size. Before Phase 4 ships, evaluate moving to individual `AIMessage` rows if conversations exceed ~50 messages. Flag this in the Phase 4 prompt.

**Why `Unsupported("vector(1536)")` for embedding?**
Prisma 7 still doesn't natively type pgvector columns. `Unsupported` preserves the column in migrations without Prisma trying to type-check it. Raw SQL queries handle vector operations.

**Why `directUrl` in datasource?**
Neon uses connection pooling on `DATABASE_URL`. Prisma migrations need a direct (non-pooled) connection. Always set both in `.env.local`.
