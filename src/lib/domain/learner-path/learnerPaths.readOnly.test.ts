import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { learnerWorld } from "@/lib/domain/learner-path/__test__/learnerWorld";
import {
  getLearningPathForLearner,
  listLearningPathsForLearner,
} from "@/lib/domain/learner-path/learnerPaths";
import { createManualAssignment } from "@/lib/domain/learning-assignment/assignments";

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

const WRITES = [
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
] as const;

type Spyable = Record<string, (...args: unknown[]) => unknown>;

/** Makes any attempt to write, through any model or raw SQL, throw. */
function forbidWrites() {
  const attempts: string[] = [];
  const forbid = (target: Spyable, method: string, label: string) =>
    vi.spyOn(target, method).mockImplementation(() => {
      attempts.push(label);
      throw new Error(`write attempted: ${label}`);
    });
  for (const model of Object.values(Prisma.ModelName)) {
    const delegate = (db as unknown as Record<string, Spyable | undefined>)[
      model.charAt(0).toLowerCase() + model.slice(1)
    ];
    if (!delegate) continue;
    for (const method of WRITES) {
      if (typeof delegate[method] === "function") forbid(delegate, method, `${model}.${method}`);
    }
  }
  for (const method of ["$executeRaw", "$executeRawUnsafe", "$transaction"]) {
    forbid(db as unknown as Spyable, method, method);
  }
  return attempts;
}

describe("the learner path read is read-only", () => {
  it("listing and reading leave every table exactly as it was, even when the learner has finished everything", async () => {
    const w = await learnerWorld();
    const [a, b, c] = await w.makeMany(3);
    if (!a || !b || !c) throw new Error("fixture");
    await w.requires(b.id, a.id);
    const assigned = await createManualAssignment(w.admin.ctx, {
      userId: w.learner.user.id,
      courseId: a.id,
      dueDate: undefined,
      note: undefined,
    });
    expect(assigned.ok).toBe(true);
    const lesson = await db.lesson.findFirstOrThrow({ where: { section: { courseId: a.id } } });
    await db.lessonProgress.create({ data: { userId: w.learner.user.id, lessonId: lesson.id } });
    await db.aIUsageEvent.create({
      data: {
        tenantId: w.tenant.id,
        userId: w.learner.user.id,
        operation: "tutor",
        provider: "test",
        model: "test",
      },
    });
    const partial = await w.publishedPath([a, b, c]);
    const finished = await w.publishedPath([c]);
    await w.complete(c.id);

    const learnerId = w.learner.user.id;
    const ids = [a.id, b.id, c.id];
    const snapshot = async () => ({
      enrollments: await db.enrollment.findMany({
        where: { userId: learnerId },
        orderBy: { id: "asc" },
      }),
      lessonProgress: await db.lessonProgress.findMany({
        where: { userId: learnerId },
        orderBy: { id: "asc" },
      }),
      assignments: await db.learningAssignment.findMany({
        where: { tenantId: w.tenant.id },
        orderBy: { id: "asc" },
      }),
      notifications: await db.notification.findMany({
        where: { userId: learnerId },
        orderBy: { id: "asc" },
      }),
      events: await db.learningEvent.findMany({
        where: { userId: learnerId },
        orderBy: { id: "asc" },
      }),
      evidence: await db.skillEvidence.findMany({
        where: { userId: learnerId },
        orderBy: { id: "asc" },
      }),
      prerequisites: await db.coursePrerequisite.findMany({
        where: { courseId: { in: ids } },
        orderBy: { id: "asc" },
      }),
      paths: await db.learningPath.findMany({
        where: { tenantId: w.tenant.id },
        orderBy: { id: "asc" },
      }),
      members: await db.learningPathCourse.findMany({
        where: { pathId: { in: [partial.id, finished.id] } },
        orderBy: { id: "asc" },
      }),
      aiUsage: await db.aIUsageEvent.findMany({
        where: { tenantId: w.tenant.id },
        orderBy: { id: "asc" },
      }),
      courses: await db.course.findMany({ where: { id: { in: ids } }, orderBy: { id: "asc" } }),
    });
    const counts = await w.sideEffects();
    const completedEvents = () =>
      db.learningEvent.count({ where: { eventType: "LEARNING_PATH_COMPLETED" } });
    const eventsBefore = await completedEvents();
    const before = await snapshot();
    expect(before.enrollments.length).toBeGreaterThan(0);
    expect(before.assignments.length).toBeGreaterThan(0);
    expect(before.notifications.length).toBeGreaterThan(0);
    expect(before.lessonProgress).toHaveLength(1);
    expect(before.aiUsage).toHaveLength(1);
    expect(before.paths).toHaveLength(2);

    const attempts = forbidWrites();
    // The guard itself works: a write through any of these now throws and is recorded.
    expect(() => db.enrollment.create({ data: {} as never })).toThrow("write attempted");
    expect(() => db.learningPath.update({ where: { id: "x" }, data: {} })).toThrow(
      "write attempted"
    );
    expect(attempts).toEqual(["Enrollment.create", "LearningPath.update"]);
    attempts.length = 0;
    const list = await listLearningPathsForLearner(w.learner.ctx);
    const one = await getLearningPathForLearner(w.learner.ctx, partial.id);
    const done = await getLearningPathForLearner(w.learner.ctx, finished.id);
    vi.restoreAllMocks();

    expect(attempts).toEqual([]);
    expect(list.paths).toHaveLength(2);
    expect(one.progress.completed).toBe(1);
    expect(done.progress).toEqual({ completed: 1, available: 0, percentage: 100 });
    expect(await snapshot()).toEqual(before);
    expect(await w.sideEffects()).toEqual(counts);
    expect(await completedEvents()).toBe(eventsBefore);
  });

  it("no source file of the learner path module contains a write, a transaction or raw SQL, or reaches for notifications, events, capability or evidence", () => {
    const dir = path.dirname(new URL(import.meta.url).pathname);
    const sources = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => ({ file: f, text: readFileSync(path.join(dir, f), "utf8") }));
    expect(sources.map((s) => s.file).sort()).toEqual(["availability.ts", "learnerPaths.ts"]);

    for (const { file, text } of sources) {
      for (const pattern of [
        /\.(create|createMany|update|updateMany|upsert|delete|deleteMany|\$transaction|\$executeRaw|\$queryRaw)\(/,
        /notifications|learning-events|LEARNING_PATH_COMPLETED|domain\/capability|SkillEvidence|skillEvidence/,
        /enrollmentAccess|paymentVerification|razorpay|lib\/ai|openai|@ai-sdk/i,
        /learning-path\/paths"/,
      ]) {
        expect(text.match(pattern), `${file} must not match ${pattern}`).toBeNull();
      }
    }
  });
});

describe("reads stay whole while the path changes underneath them", () => {
  it("readers racing an archive, a republish and membership changes each get a complete path or NOT_FOUND, never a 500", async () => {
    const w = await learnerWorld();
    const courses = await w.makeMany(4);
    const path = await w.publishedPath(courses.slice(0, 3));
    const {
      archiveLearningPath,
      publishLearningPath,
      addCourseToLearningPath,
      removeCourseFromLearningPath,
    } = await import("@/lib/domain/learning-path/paths");
    const extra = courses[3];
    if (!extra) throw new Error("fixture");

    const readers = Array.from({ length: 12 }, () =>
      getLearningPathForLearner(w.learner.ctx, path.id).then(
        (r) => r,
        (err) => err
      )
    );
    const writers = (async () => {
      await archiveLearningPath(w.admin.ctx, path.id);
      await publishLearningPath(w.admin.ctx, path.id);
      await addCourseToLearningPath(w.admin.ctx, path.id, { courseId: extra.id });
      await removeCourseFromLearningPath(w.admin.ctx, path.id, extra.id);
    })();
    const [, ...rest] = await Promise.all([writers, ...readers]);
    const results = rest as (Awaited<ReturnType<typeof getLearningPathForLearner>> | Error)[];

    for (const result of results) {
      if (result instanceof Error) {
        expect((result as { code?: string }).code).toBe("NOT_FOUND");
      } else {
        expect(result.status).toBe("PUBLISHED");
        expect([3, 4]).toContain(result.courses.length);
        expect(result.courses.map((c) => c.position)).toEqual(
          [...result.courses.map((c) => c.position)].sort((x, y) => x - y)
        );
      }
    }
  });
});
