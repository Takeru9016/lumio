import { auth } from "@clerk/nextjs/server";
import { generateObject } from "ai";
import { z } from "zod";

import { withAiGuards } from "@/lib/ai/middleware";
import { openai } from "@/lib/ai/openai";
import { LEARNING_PATH_SYSTEM_PROMPT } from "@/lib/ai/prompts";
import { incrementAiUsage } from "@/lib/ai/quota";
import { db } from "@/lib/db";
import { pathRatelimit } from "@/lib/ratelimit";

// Keeps the candidate list (and therefore the prompt) small enough that the
// model can reliably ground every recommendation in a real lesson id.
const MAX_CANDIDATE_LESSONS = 30;
const RECENT_PROGRESS_TAKE = 20;
const RECENT_QUIZ_ATTEMPTS_TAKE = 10;

const learningPathSchema = z.object({
  recommendations: z
    .array(
      z.object({
        lessonId: z.string(),
        reason: z.string(),
        priority: z.enum(["HIGH", "MEDIUM", "LOW"]),
      })
    )
    .max(5),
  summary: z.string(),
});

interface LearningPathRequestBody {
  courseId?: string;
}

export async function POST(req: Request) {
  const { userId } = await auth();

  const guard = await withAiGuards(userId, pathRatelimit);
  if (!guard.ok) return guard.response;
  const { user } = guard;

  if (user.role !== "STUDENT") {
    return Response.json({ error: "Only students can generate a learning path" }, { status: 403 });
  }

  let body: LearningPathRequestBody;
  try {
    body = (await req.json()) as LearningPathRequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { courseId } = body;

  const enrollments = await db.enrollment.findMany({
    where: {
      userId: user.id,
      status: { in: ["ACTIVE", "COMPLETED"] },
      ...(courseId ? { courseId } : {}),
    },
    select: { courseId: true, course: { select: { title: true } } },
  });

  if (enrollments.length === 0) {
    return Response.json({
      recommendations: [],
      summary: "Enroll in a course to get a personalised learning path.",
    });
  }
  const enrolledCourseIds = enrollments.map((e) => e.courseId);

  const [courseCompletion, recentProgress, recentQuizAttempts, candidateLessons] =
    await Promise.all([
      Promise.all(
        enrollments.map(async (e) => {
          const [total, completed] = await Promise.all([
            db.lesson.count({
              where: { section: { courseId: e.courseId }, isPublished: true, isArchived: false },
            }),
            db.lessonProgress.count({
              where: {
                userId: user.id,
                isCompleted: true,
                lesson: { section: { courseId: e.courseId }, isPublished: true, isArchived: false },
              },
            }),
          ]);
          return {
            courseTitle: e.course.title,
            percent: total > 0 ? Math.round((completed / total) * 100) : 0,
          };
        })
      ),
      db.lessonProgress.findMany({
        where: { userId: user.id, lesson: { section: { courseId: { in: enrolledCourseIds } } } },
        orderBy: { updatedAt: "desc" },
        take: RECENT_PROGRESS_TAKE,
        select: {
          isCompleted: true,
          lesson: {
            select: { title: true, section: { select: { course: { select: { title: true } } } } },
          },
        },
      }),
      db.quizAttempt.findMany({
        where: {
          userId: user.id,
          quiz: { lesson: { section: { courseId: { in: enrolledCourseIds } } } },
        },
        orderBy: { completedAt: "desc" },
        take: RECENT_QUIZ_ATTEMPTS_TAKE,
        select: {
          score: true,
          isPassed: true,
          quiz: {
            select: {
              title: true,
              lesson: { select: { section: { select: { course: { select: { title: true } } } } } },
            },
          },
        },
      }),
      db.lesson.findMany({
        where: {
          section: { courseId: { in: enrolledCourseIds } },
          isPublished: true,
          isArchived: false,
          progress: { none: { userId: user.id, isCompleted: true } },
        },
        orderBy: [
          { section: { courseId: "asc" } },
          { section: { order: "asc" } },
          { order: "asc" },
        ],
        take: MAX_CANDIDATE_LESSONS,
        select: {
          id: true,
          title: true,
          section: { select: { course: { select: { id: true, title: true } } } },
        },
      }),
    ]);

  if (candidateLessons.length === 0) {
    return Response.json({
      recommendations: [],
      summary: "You've completed every lesson in your enrolled courses. Great work!",
    });
  }

  const completionLines = courseCompletion.map((c) => {
    const courseQuizAttempts = recentQuizAttempts.filter(
      (a) => a.quiz.lesson.section.course.title === c.courseTitle
    );
    const avgCourseScore =
      courseQuizAttempts.length > 0
        ? Math.round(
            courseQuizAttempts.reduce((sum, a) => sum + a.score, 0) / courseQuizAttempts.length
          )
        : null;
    return avgCourseScore !== null
      ? `- Student completed ${c.percent}% of "${c.courseTitle}", scored ${avgCourseScore}% on quizzes`
      : `- Student completed ${c.percent}% of "${c.courseTitle}", no quiz attempts yet`;
  });

  const avgQuizScore =
    recentQuizAttempts.length > 0
      ? Math.round(
          recentQuizAttempts.reduce((sum, a) => sum + a.score, 0) / recentQuizAttempts.length
        )
      : null;

  const recentActivityLines = recentProgress
    .slice(0, 10)
    .map(
      (p) =>
        `- ${p.lesson.title} (${p.lesson.section.course.title}): ${
          p.isCompleted ? "completed" : "in progress"
        }`
    );

  const quizLines = recentQuizAttempts
    .slice(0, 10)
    .map(
      (a) =>
        `- ${a.quiz.title} (${a.quiz.lesson.section.course.title}): scored ${a.score}% (${
          a.isPassed ? "passed" : "failed"
        })`
    );

  const candidateLines = candidateLessons.map(
    (l) => `- id: ${l.id} | title: "${l.title}" | course: "${l.section.course.title}"`
  );

  const context = [
    `Enrolled courses:\n${completionLines.join("\n")}`,
    avgQuizScore !== null
      ? `Average quiz score (last ${recentQuizAttempts.length} attempts): ${avgQuizScore}%`
      : null,
    recentActivityLines.length > 0
      ? `Recent lesson activity:\n${recentActivityLines.join("\n")}`
      : null,
    quizLines.length > 0 ? `Recent quiz attempts:\n${quizLines.join("\n")}` : null,
    `Candidate lessons (not yet completed):\n${candidateLines.join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const candidateById = new Map(candidateLessons.map((l) => [l.id, l]));

  let recommendations: z.infer<typeof learningPathSchema>["recommendations"];
  let summary: string;
  try {
    const { object } = await generateObject({
      model: openai("gpt-5.4"),
      schema: learningPathSchema,
      system: LEARNING_PATH_SYSTEM_PROMPT(context),
      prompt: "Generate the learning path recommendations now.",
    });
    recommendations = object.recommendations.filter((r) => candidateById.has(r.lessonId));
    summary = object.summary;
  } catch {
    return Response.json(
      { error: "AI failed to generate a learning path. Please try again." },
      { status: 502 }
    );
  }

  await incrementAiUsage(user.id);

  // Enrich with the lesson/course info the UI needs to render a link, so the
  // client never has to re-fetch lesson details just to build "Start Lesson →".
  const enrichedRecommendations = recommendations.map((r) => {
    const lesson = candidateById.get(r.lessonId);
    return {
      ...r,
      lessonTitle: lesson?.title ?? "",
      courseId: lesson?.section.course.id ?? "",
      courseTitle: lesson?.section.course.title ?? "",
    };
  });

  return Response.json({ recommendations: enrichedRecommendations, summary });
}
