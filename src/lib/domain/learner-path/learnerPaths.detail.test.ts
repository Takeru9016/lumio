import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { learnerWorld, refusalOf } from "@/lib/domain/learner-path/__test__/learnerWorld";
import { getLearningPathForLearner } from "@/lib/domain/learner-path/learnerPaths";

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

const detail = (w: Awaited<ReturnType<typeof learnerWorld>>, pathId: string) =>
  getLearningPathForLearner(w.learner.ctx, pathId);

describe("getLearningPathForLearner — which paths a learner can see", () => {
  it("shows a PUBLISHED path of the learner's tenant, with only learner-safe fields", async () => {
    const w = await learnerWorld();
    const course = await w.make();
    const path = await w.publishedPath([course], "Leadership");
    await db.learningPath.update({ where: { id: path.id }, data: { description: "About it" } });

    const result = await detail(w, path.id);

    expect(Object.keys(result).sort()).toEqual([
      "courses",
      "description",
      "id",
      "progress",
      "publishedAt",
      "status",
      "title",
    ]);
    expect(result).toMatchObject({
      id: path.id,
      title: "Leadership",
      description: "About it",
      status: "PUBLISHED",
    });
    expect(result.publishedAt).toBeInstanceOf(Date);
    const text = JSON.stringify(result);
    for (const secret of [w.tenant.id, w.admin.user.id, "createdById", "tenantId", "createdAt"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("a DRAFT path, an ARCHIVED path, another tenant's path, an unknown id and a malformed id are the same NOT_FOUND", async () => {
    const w = await learnerWorld();
    const other = await learnerWorld();
    const course = await w.make();
    const draft = await w.makePath({ courses: [course] });
    const archived = await w.makePath({ status: "ARCHIVED", courses: [course] });
    const foreign = await other.publishedPath([await other.make()]);

    const errors = [];
    for (const id of [
      draft.id,
      archived.id,
      foreign.id,
      "does-not-exist",
      "bad id!",
      "",
      5,
      null,
    ]) {
      try {
        await detail(w, id as string);
        errors.push("no error");
      } catch (err) {
        errors.push(
          JSON.stringify({
            name: (err as Error).name,
            m: (err as Error).message,
            c: (err as { code?: string }).code,
          })
        );
      }
    }

    expect(new Set(errors).size).toBe(1);
    expect(JSON.parse(errors[0] ?? "{}")).toMatchObject({ c: "NOT_FOUND" });
  });

  it("follows the lifecycle: gone when archived, back when republished", async () => {
    const w = await learnerWorld();
    const path = await w.publishedPath([await w.make()]);
    expect((await detail(w, path.id)).id).toBe(path.id);

    await db.learningPath.update({ where: { id: path.id }, data: { status: "ARCHIVED" } });
    expect(await refusalOf(() => detail(w, path.id))).toBe("NOT_FOUND");

    await db.learningPath.update({ where: { id: path.id }, data: { status: "PUBLISHED" } });
    expect((await detail(w, path.id)).id).toBe(path.id);
  });

  it("another learner of the same tenant sees the same path, with their own progress", async () => {
    const w = await learnerWorld();
    const a = await w.make();
    const path = await w.publishedPath([a]);
    const other = await w.otherLearner();
    await w.complete(a.id, other.user.id);

    expect((await detail(w, path.id)).progress.completed).toBe(0);
    expect((await getLearningPathForLearner(other.ctx, path.id)).progress.completed).toBe(1);
  });
});

describe("getLearningPathForLearner — courses and order", () => {
  it("lists the courses by position, whatever order they were stored in, and breaks ties by course id", async () => {
    const w = await learnerWorld();
    const courses = await w.makeMany(4);
    const [a, b, c, d] = courses;
    if (!a || !b || !c || !d) throw new Error("fixture");
    const path = await w.makePath({ status: "PUBLISHED" });
    for (const [course, position] of [
      [c, 3],
      [a, 1],
      [b, 2],
      [d, 2],
    ] as const) {
      await db.learningPathCourse.create({
        data: { pathId: path.id, courseId: course.id, position },
      });
    }

    const result = await detail(w, path.id);

    const tied = [b.id, d.id].sort();
    expect(result.courses.map((x) => x.position)).toEqual([1, 2, 2, 3]);
    expect(result.courses.map((x) => x.courseId)).toEqual([a.id, tied[0], tied[1], c.id]);
  });

  it("orders by position even when the database hands the members back in another order", async () => {
    const w = await learnerWorld();
    const [a, b, c] = await w.makeMany(3);
    if (!a || !b || !c) throw new Error("fixture");
    const path = await w.publishedPath([a, b, c]);
    const real = db.learningPathCourse.findMany.bind(db.learningPathCourse) as (
      args: unknown
    ) => Promise<unknown[]>;
    vi.spyOn(db.learningPathCourse, "findMany").mockImplementation(((args: unknown) =>
      real(args).then((rows) => [...rows].reverse())) as never);

    const result = await detail(w, path.id);

    expect(result.courses.map((x) => x.position)).toEqual([1, 2, 3]);
    expect(result.courses.map((x) => x.courseId)).toEqual([a.id, b.id, c.id]);
  });

  it("position is only advice: a later course is not held back by an earlier one", async () => {
    const w = await learnerWorld();
    const [a, b] = await w.makeMany(2);
    if (!a || !b) throw new Error("fixture");
    const path = await w.publishedPath([a, b]);

    const result = await detail(w, path.id);

    expect(result.courses.map((c) => c.availability)).toEqual(["AVAILABLE", "AVAILABLE"]);
  });

  it("an empty published path has no courses and null progress", async () => {
    const w = await learnerWorld();
    const path = await w.publishedPath([]);

    const result = await detail(w, path.id);

    expect(result.courses).toEqual([]);
    expect(result.progress).toEqual({ completed: 0, available: 0, percentage: null });
  });
});

describe("getLearningPathForLearner — availability", () => {
  it("AVAILABLE course: navigation fields and prerequisite state, nothing else", async () => {
    const w = await learnerWorld();
    const course = await w.make();
    const path = await w.publishedPath([course]);

    expect((await detail(w, path.id)).courses).toEqual([
      {
        courseId: course.id,
        slug: course.slug,
        title: course.title,
        position: 1,
        availability: "AVAILABLE",
        prerequisiteState: "NONE",
      },
    ]);
  });

  it("COMPLETED only when the learner's Enrollment is COMPLETED: ACTIVE and REFUNDED are not", async () => {
    const w = await learnerWorld();
    const [active, refunded, done, none] = await w.makeMany(4);
    if (!active || !refunded || !done || !none) throw new Error("fixture");
    await w.enroll(w.learner.user.id, active.id, "ACTIVE");
    await w.enroll(w.learner.user.id, refunded.id, "REFUNDED");
    await w.enroll(w.learner.user.id, done.id, "COMPLETED");
    const path = await w.publishedPath([active, refunded, done, none]);

    const result = await detail(w, path.id);

    expect(result.courses.map((c) => c.availability)).toEqual([
      "AVAILABLE",
      "AVAILABLE",
      "COMPLETED",
      "AVAILABLE",
    ]);
    expect(result.progress).toEqual({ completed: 1, available: 3, percentage: 25 });
  });

  it("completion is the enrollment and nothing else: finished lessons, an assignment or a later position do not complete a course", async () => {
    const w = await learnerWorld();
    const course = await w.make();
    const lesson = await db.lesson.findFirstOrThrow({
      where: { section: { courseId: course.id } },
    });
    await db.lessonProgress.create({
      data: {
        userId: w.learner.user.id,
        lessonId: lesson.id,
        isCompleted: true,
        completedAt: new Date(),
      },
    });
    const path = await w.publishedPath([course]);

    expect((await detail(w, path.id)).courses[0]?.availability).toBe("AVAILABLE");
  });

  it("a completed course stays COMPLETED, with its name, after it is archived, unpublished or emptied", async () => {
    const w = await learnerWorld();
    const [archived, draft, bare] = await w.makeMany(3);
    if (!archived || !draft || !bare) throw new Error("fixture");
    for (const course of [archived, draft, bare]) await w.complete(course.id);
    await w.archive(archived.id);
    await w.unpublish(draft.id);
    await w.removeLessons(bare.id);
    const path = await w.publishedPath([archived, draft, bare]);

    const result = await detail(w, path.id);

    expect(result.courses).toEqual([
      expect.objectContaining({
        courseId: archived.id,
        title: archived.title,
        availability: "COMPLETED",
      }),
      expect.objectContaining({
        courseId: draft.id,
        title: draft.title,
        availability: "COMPLETED",
      }),
      expect.objectContaining({ courseId: bare.id, title: bare.title, availability: "COMPLETED" }),
    ]);
    expect(result.progress).toEqual({ completed: 3, available: 0, percentage: 100 });
  });

  it("an archived, draft and lessonless course is UNAVAILABLE, and the learner learns nothing about it", async () => {
    const w = await learnerWorld();
    const [live, archived, draft, bare] = await Promise.all([
      w.make(),
      w.make({ status: "ARCHIVED" }),
      w.make({ status: "DRAFT" }),
      w.make({ lessons: false }),
    ]);
    const path = await w.publishedPath([live, archived, draft, bare]);
    await db.course.updateMany({
      where: { id: { in: [archived.id, draft.id, bare.id] } },
      data: { description: "Secret description" },
    });

    const result = await detail(w, path.id);

    expect(result.courses).toEqual([
      expect.objectContaining({ courseId: live.id, availability: "AVAILABLE" }),
      { position: 2, availability: "UNAVAILABLE", prerequisiteState: "NONE" },
      { position: 3, availability: "UNAVAILABLE", prerequisiteState: "NONE" },
      { courseId: bare.id, position: 4, availability: "UNAVAILABLE", prerequisiteState: "NONE" },
    ]);
    const text = JSON.stringify(result);
    for (const secret of [
      archived.id,
      archived.slug,
      archived.title,
      draft.id,
      draft.slug,
      draft.title,
      bare.slug,
      bare.title,
      "Secret description",
      w.instructor.user.id,
      w.instructor.user.email,
    ]) {
      expect(text, secret).not.toContain(secret);
    }
    expect(result.progress).toEqual({ completed: 0, available: 1, percentage: 0 });
  });

  it("a course blocked by a prerequisite is UNAVAILABLE and reveals neither its own name nor the prerequisite's", async () => {
    const w = await learnerWorld();
    const [blocked, prerequisite] = await w.makeMany(2);
    if (!blocked || !prerequisite) throw new Error("fixture");
    await w.requires(blocked.id, prerequisite.id);
    const path = await w.publishedPath([blocked]);

    const result = await detail(w, path.id);

    expect(result.courses).toEqual([
      {
        courseId: blocked.id,
        position: 1,
        availability: "UNAVAILABLE",
        prerequisiteState: "UNMET",
      },
    ]);
    const text = JSON.stringify(result);
    for (const secret of [
      blocked.slug,
      blocked.title,
      prerequisite.id,
      prerequisite.slug,
      prerequisite.title,
    ]) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it("completing the prerequisite makes the blocked course AVAILABLE, with its name", async () => {
    const w = await learnerWorld();
    const [blocked, prerequisite] = await w.makeMany(2);
    if (!blocked || !prerequisite) throw new Error("fixture");
    await w.requires(blocked.id, prerequisite.id);
    const path = await w.publishedPath([blocked]);
    await w.complete(prerequisite.id);

    expect((await detail(w, path.id)).courses).toEqual([
      {
        courseId: blocked.id,
        slug: blocked.slug,
        title: blocked.title,
        position: 1,
        availability: "AVAILABLE",
        prerequisiteState: "MET",
      },
    ]);
  });

  it("a course that drifts after publication is judged as it is now, and the path is left alone", async () => {
    const w = await learnerWorld();
    const [a, b] = await w.makeMany(2);
    if (!a || !b) throw new Error("fixture");
    const path = await w.publishedPath([a, b]);
    await w.archive(b.id);

    const result = await detail(w, path.id);

    expect(result.courses.map((c) => c.availability)).toEqual(["AVAILABLE", "UNAVAILABLE"]);
    expect(await w.memberIds(path.id)).toEqual([a.id, b.id]);
    expect((await db.learningPath.findUniqueOrThrow({ where: { id: path.id } })).status).toBe(
      "PUBLISHED"
    );
  });

  it("makes no enrollment for a paid course: it is navigable metadata only", async () => {
    const w = await learnerWorld();
    const paid = await w.make();
    await db.course.update({ where: { id: paid.id }, data: { price: 4999, currency: "INR" } });
    const path = await w.publishedPath([paid]);

    const result = await detail(w, path.id);

    expect(result.courses[0]).toMatchObject({ availability: "AVAILABLE" });
    expect(JSON.stringify(result)).not.toMatch(/4999|price|INR/);
    expect(await db.enrollment.count({ where: { courseId: paid.id } })).toBe(0);
  });
});

describe("getLearningPathForLearner — a membership that should not exist", () => {
  it("a foreign or tenantless course forced into the path is UNAVAILABLE, unnamed, uncounted, and leaks nothing", async () => {
    const w = await learnerWorld();
    const good = await w.make();
    const foreign = await w.makeForeign();
    const open = await w.makeTenantless();
    await w.complete(foreign.id);
    const path = await w.publishedPath([good]);
    await db.learningPathCourse.createMany({
      data: [
        { pathId: path.id, courseId: foreign.id, position: 2 },
        { pathId: path.id, courseId: open.id, position: 3 },
      ],
    });

    const result = await detail(w, path.id);

    expect(result.courses).toEqual([
      expect.objectContaining({ courseId: good.id, availability: "AVAILABLE" }),
      { position: 2, availability: "UNAVAILABLE", prerequisiteState: "NONE" },
      { position: 3, availability: "UNAVAILABLE", prerequisiteState: "NONE" },
    ]);
    expect(result.progress).toEqual({ completed: 0, available: 1, percentage: 0 });
    const text = JSON.stringify(result);
    for (const secret of [
      foreign.id,
      foreign.slug,
      foreign.title,
      open.id,
      open.slug,
      open.title,
      "tenant",
    ]) {
      expect(text, secret).not.toContain(secret);
    }
    expect(await w.memberIds(path.id)).toHaveLength(3);
  });
});
