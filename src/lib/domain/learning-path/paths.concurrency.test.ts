import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { errorCodeOf, pathWorld } from "@/lib/domain/learning-path/__test__/pathWorld";
import { LEARNING_PATH_MAX_COURSES } from "@/lib/domain/learning-path/constants";
import {
  addCourseToLearningPath,
  removeCourseFromLearningPath,
  reorderLearningPath,
  updateLearningPath,
} from "@/lib/domain/learning-path/paths";

afterAll(async () => {
  await db.$disconnect();
});

const codes = async (calls: (() => Promise<unknown>)[]) =>
  Promise.all(calls.map((call) => errorCodeOf(call)));

/**
 * Holds the path's row lock in an open transaction, running `whileLocked` inside it,
 * until `release` is called: what a competing writer that has not committed yet
 * looks like to the operation under test.
 */
function holdLock(
  pathId: string,
  whileLocked: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<void>
) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked: () => void = () => {};
  const isLocked = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const done = db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "LearningPath" WHERE id = ${pathId} FOR UPDATE`;
    locked();
    await gate;
    await whileLocked(tx);
  });
  return { isLocked, release, done };
}

const settledWithin = (promise: Promise<unknown>, ms: number) =>
  Promise.race([
    promise.then(
      () => true,
      () => true
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);

describe("concurrent adds", () => {
  it("8 admins adding the same course at once: one row, one success, seven DUPLICATE", async () => {
    const w = await pathWorld();
    const course = await w.make();
    const path = await w.makePath();

    const results = await codes(
      Array.from(
        { length: 8 },
        () => () => addCourseToLearningPath(w.admin.ctx, path.id, { courseId: course.id })
      )
    );

    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(results.filter((r) => r === "DUPLICATE")).toHaveLength(7);
    expect(await w.members(path.id)).toEqual([{ courseId: course.id, position: 1 }]);
  });

  it("racing for the last places never produces more than 20 members", async () => {
    const w = await pathWorld();
    const courses = await w.makeMany(LEARNING_PATH_MAX_COURSES + 2);
    const path = await w.makePath({ courses: courses.slice(0, LEARNING_PATH_MAX_COURSES - 1) });

    const results = await codes(
      courses
        .slice(LEARNING_PATH_MAX_COURSES - 1)
        .map(
          (course) => () => addCourseToLearningPath(w.admin.ctx, path.id, { courseId: course.id })
        )
    );

    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(results.filter((r) => r === "LIMIT_REACHED")).toHaveLength(2);
    expect(await db.learningPathCourse.count({ where: { pathId: path.id } })).toBe(
      LEARNING_PATH_MAX_COURSES
    );
  });

  it("different courses added at once each get their own position, 1..n with no repeat", async () => {
    const w = await pathWorld();
    const courses = await w.makeMany(6);
    const path = await w.makePath();

    const results = await codes(
      courses.map(
        (course) => () => addCourseToLearningPath(w.admin.ctx, path.id, { courseId: course.id })
      )
    );

    expect(results.every((r) => r === null)).toBe(true);
    expect((await w.members(path.id)).map((m) => m.position)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("concurrent reorders and removals", () => {
  it("8 reorders at once: each succeeds, and the result is exactly one of the requested orders", async () => {
    const w = await pathWorld();
    const courses = await w.makeMany(5);
    const path = await w.makePath({ courses });
    const ids = courses.map((c) => c.id);
    const orders = Array.from({ length: 8 }, (_, shift) => [
      ...ids.slice(shift % 5),
      ...ids.slice(0, shift % 5),
    ]).map((order, i) => (i % 2 === 0 ? order : [...order].reverse()));

    const results = await codes(
      orders.map((order) => () => reorderLearningPath(w.admin.ctx, path.id, { courseIds: order }))
    );

    expect(results.every((r) => r === null)).toBe(true);
    const final = await w.members(path.id);
    expect(final.map((m) => m.position)).toEqual([1, 2, 3, 4, 5]);
    expect(orders.map((o) => o.join())).toContain(final.map((m) => m.courseId).join());
  });

  it("a removal racing a reorder that names the removed course: no partial state, no lost renumbering", async () => {
    const w = await pathWorld();
    const [a, b, c, d] = await w.makeMany(4);
    if (!a || !b || !c || !d) throw new Error("fixture");
    const path = await w.makePath({ courses: [a, b, c, d] });
    const lock = holdLock(path.id, async () => {});
    await lock.isLocked;

    const removal = errorCodeOf(() => removeCourseFromLearningPath(w.admin.ctx, path.id, b.id));
    const reordering = errorCodeOf(() =>
      reorderLearningPath(w.admin.ctx, path.id, { courseIds: [d.id, c.id, b.id, a.id] })
    );
    expect(await settledWithin(Promise.all([removal, reordering]), 150)).toBe(false);
    lock.release();
    await lock.done;
    const [removed, reordered] = await Promise.all([removal, reordering]);

    expect(removed).toBeNull();
    expect(["STALE_ORDER", null]).toContain(reordered);
    const final = await w.members(path.id);
    expect(final.map((m) => m.courseId)).not.toContain(b.id);
    expect(final.map((m) => m.position)).toEqual([1, 2, 3]);
    if (reordered === null) {
      expect(final.map((m) => m.courseId)).toEqual([d.id, c.id, a.id]);
    } else {
      expect(final.map((m) => m.courseId)).toEqual([a.id, c.id, d.id]);
    }
  });

  it("two removals at once: both go, and what is left is 1..n", async () => {
    const w = await pathWorld();
    const [a, b, c, d] = await w.makeMany(4);
    if (!a || !b || !c || !d) throw new Error("fixture");
    const path = await w.makePath({ courses: [a, b, c, d] });

    const results = await codes([
      () => removeCourseFromLearningPath(w.admin.ctx, path.id, a.id),
      () => removeCourseFromLearningPath(w.admin.ctx, path.id, c.id),
    ]);

    expect(results).toEqual([null, null]);
    expect(await w.members(path.id)).toEqual([
      { courseId: b.id, position: 1 },
      { courseId: d.id, position: 2 },
    ]);
  });

  it("two removals of the same course at once: one succeeds, the other is COURSE_NOT_FOUND", async () => {
    const w = await pathWorld();
    const [a, b] = await w.makeMany(2);
    if (!a || !b) throw new Error("fixture");
    const path = await w.makePath({ courses: [a, b] });

    const results = await codes([
      () => removeCourseFromLearningPath(w.admin.ctx, path.id, a.id),
      () => removeCourseFromLearningPath(w.admin.ctx, path.id, a.id),
    ]);

    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(results.filter((r) => r === "COURSE_NOT_FOUND")).toHaveLength(1);
    expect(await w.members(path.id)).toEqual([{ courseId: b.id, position: 1 }]);
  });

  it("two removals racing for a published path's last two courses: the last one is refused", async () => {
    const w = await pathWorld();
    const [a, b] = await w.makeMany(2);
    if (!a || !b) throw new Error("fixture");
    const path = await w.makePath({ status: "PUBLISHED", courses: [a, b] });

    const results = await codes([
      () => removeCourseFromLearningPath(w.admin.ctx, path.id, a.id),
      () => removeCourseFromLearningPath(w.admin.ctx, path.id, b.id),
    ]);

    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(results.filter((r) => r === "LAST_COURSE")).toHaveLength(1);
    expect(await db.learningPathCourse.count({ where: { pathId: path.id } })).toBe(1);
  });
});

describe("the path lock", () => {
  it("an edit that waits behind a competing archive sees the archive, and is refused", async () => {
    const w = await pathWorld();
    const path = await w.makePath({
      status: "PUBLISHED",
      title: "Same",
      courses: [await w.make()],
    });
    const lock = holdLock(path.id, async (tx) => {
      await tx.learningPath.update({ where: { id: path.id }, data: { status: "ARCHIVED" } });
    });
    await lock.isLocked;

    const edit = errorCodeOf(() => updateLearningPath(w.admin.ctx, path.id, { title: "Changed" }));
    expect(await settledWithin(edit, 150)).toBe(false);
    lock.release();
    await lock.done;

    expect(await edit).toBe("PATH_ARCHIVED");
    expect(await db.learningPath.findUniqueOrThrow({ where: { id: path.id } })).toMatchObject({
      status: "ARCHIVED",
      title: "Same",
    });
  });

  it("an add that waits behind a competing archive sees the archive, and adds nothing", async () => {
    const w = await pathWorld();
    const course = await w.make();
    const path = await w.makePath({ status: "PUBLISHED", courses: [await w.make()] });
    const lock = holdLock(path.id, async (tx) => {
      await tx.learningPath.update({ where: { id: path.id }, data: { status: "ARCHIVED" } });
    });
    await lock.isLocked;

    const adding = errorCodeOf(() =>
      addCourseToLearningPath(w.admin.ctx, path.id, { courseId: course.id })
    );
    expect(await settledWithin(adding, 150)).toBe(false);
    lock.release();
    await lock.done;

    expect(await adding).toBe("PATH_ARCHIVED");
    expect(await w.memberIds(path.id)).not.toContain(course.id);
  });

  it("a reorder and a removal that wait behind an archive are refused too, and change nothing", async () => {
    const w = await pathWorld();
    const [a, b] = await w.makeMany(2);
    if (!a || !b) throw new Error("fixture");
    const path = await w.makePath({ courses: [a, b] });
    const lock = holdLock(path.id, async (tx) => {
      await tx.learningPath.update({ where: { id: path.id }, data: { status: "ARCHIVED" } });
    });
    await lock.isLocked;

    const reordering = errorCodeOf(() =>
      reorderLearningPath(w.admin.ctx, path.id, { courseIds: [b.id, a.id] })
    );
    const removing = errorCodeOf(() => removeCourseFromLearningPath(w.admin.ctx, path.id, a.id));
    expect(await settledWithin(Promise.all([reordering, removing]), 150)).toBe(false);
    lock.release();
    await lock.done;

    expect(await Promise.all([reordering, removing])).toEqual(["PATH_ARCHIVED", "PATH_ARCHIVED"]);
    expect(await w.members(path.id)).toEqual([
      { courseId: a.id, position: 1 },
      { courseId: b.id, position: 2 },
    ]);
  });

  it("an add decides the limit on the members it finds after the lock, not before", async () => {
    const w = await pathWorld();
    const courses = await w.makeMany(LEARNING_PATH_MAX_COURSES);
    const extra = await w.make();
    const path = await w.makePath({ courses: courses.slice(0, LEARNING_PATH_MAX_COURSES - 1) });
    const lock = holdLock(path.id, async (tx) => {
      await tx.learningPathCourse.create({
        data: {
          pathId: path.id,
          courseId: courses[LEARNING_PATH_MAX_COURSES - 1]?.id ?? "",
          position: LEARNING_PATH_MAX_COURSES,
        },
      });
    });
    await lock.isLocked;

    const adding = errorCodeOf(() =>
      addCourseToLearningPath(w.admin.ctx, path.id, { courseId: extra.id })
    );
    expect(await settledWithin(adding, 150)).toBe(false);
    lock.release();
    await lock.done;

    expect(await adding).toBe("LIMIT_REACHED");
    expect(await db.learningPathCourse.count({ where: { pathId: path.id } })).toBe(
      LEARNING_PATH_MAX_COURSES
    );
  });

  it("a lock on one path does not hold up another", async () => {
    const w = await pathWorld();
    const busy = await w.makePath();
    const free = await w.makePath();
    const course = await w.make();
    const lock = holdLock(busy.id, async () => {});
    await lock.isLocked;

    const adding = addCourseToLearningPath(w.admin.ctx, free.id, { courseId: course.id });

    expect(await settledWithin(adding, 2000)).toBe(true);
    lock.release();
    await lock.done;
    expect(await w.memberIds(free.id)).toEqual([course.id]);
  });
});
