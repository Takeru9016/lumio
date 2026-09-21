import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { holdLock, settledWithin } from "@/lib/domain/learning-path/__test__/lock";
import { errorCodeOf, pathWorld } from "@/lib/domain/learning-path/__test__/pathWorld";
import { archiveLearningPath, publishLearningPath } from "@/lib/domain/learning-path/paths";

afterAll(async () => {
  await db.$disconnect();
});

const row = (id: string) => db.learningPath.findUniqueOrThrow({ where: { id } });

const codes = (calls: (() => Promise<unknown>)[]) => Promise.all(calls.map((c) => errorCodeOf(c)));

describe("concurrent lifecycle changes serialize on the path lock", () => {
  it("publish racing archive on a DRAFT: both succeed, one after the other, and the path is in exactly one of the two serial end states", async () => {
    const w = await pathWorld();
    const path = await w.makePath({ courses: await w.makeMany(2) });
    const members = await w.members(path.id);

    const [published, archived] = await codes([
      () => publishLearningPath(w.admin.ctx, path.id),
      () => archiveLearningPath(w.admin.ctx, path.id),
    ]);

    // Either order is legal, and DRAFT → ARCHIVED → PUBLISHED is legal too.
    expect([published, archived]).toEqual([null, null]);
    const after = await row(path.id);
    expect(["PUBLISHED", "ARCHIVED"]).toContain(after.status);
    expect(after.publishedAt).not.toBeNull();
    expect(await w.members(path.id)).toEqual(members);
  });

  it("archive racing publish on a PUBLISHED path: the publish is judged on what the archive committed", async () => {
    const w = await pathWorld();
    const path = await w.makePath({ status: "PUBLISHED", courses: [await w.make()] });
    const publishedAt = (await row(path.id)).publishedAt;
    await new Promise((r) => setTimeout(r, 15));

    const [published, archived] = await codes([
      () => publishLearningPath(w.admin.ctx, path.id),
      () => archiveLearningPath(w.admin.ctx, path.id),
    ]);

    const after = await row(path.id);
    if (published === null) {
      // The archive ran first, so the publish was a republish.
      expect(archived).toBeNull();
      expect(after.status).toBe("PUBLISHED");
      expect(after.publishedAt?.getTime()).toBeGreaterThan(publishedAt?.getTime() ?? 0);
    } else {
      // The publish ran first and found it already PUBLISHED.
      expect(published).toBe("INVALID_TRANSITION");
      expect(archived).toBeNull();
      expect(after.status).toBe("ARCHIVED");
      expect(after.publishedAt).toEqual(publishedAt);
    }
  });

  it("archive queued behind a publish on a PUBLISHED path sees ARCHIVED-or-PUBLISHED by commit order, never a mixture", async () => {
    const w = await pathWorld();
    const path = await w.makePath({ status: "PUBLISHED", courses: [await w.make()] });
    const lock = holdLock(path.id);
    await lock.isLocked;

    const archiving = errorCodeOf(() => archiveLearningPath(w.admin.ctx, path.id));
    await new Promise((r) => setTimeout(r, 100));
    const publishing = errorCodeOf(() => publishLearningPath(w.admin.ctx, path.id));
    expect(await settledWithin(Promise.all([archiving, publishing]), 150)).toBe(false);
    lock.release();
    await lock.done;

    const [archived, published] = await Promise.all([archiving, publishing]);
    const after = await row(path.id);
    expect(archived).toBeNull();
    if (published === null) {
      expect(after.status).toBe("PUBLISHED");
    } else {
      expect(published).toBe("INVALID_TRANSITION");
      expect(after.status).toBe("ARCHIVED");
    }
  });

  it.each(["DRAFT", "ARCHIVED"] as const)(
    "8 simultaneous publishes of a %s path: one transitions, seven are INVALID_TRANSITION",
    async (from) => {
      const w = await pathWorld();
      const path = await w.makePath({ status: from, courses: [await w.make()] });

      const results = await codes(
        Array.from({ length: 8 }, () => () => publishLearningPath(w.admin.ctx, path.id))
      );

      expect(results.filter((r) => r === null)).toHaveLength(1);
      expect(results.filter((r) => r === "INVALID_TRANSITION")).toHaveLength(7);
      expect((await row(path.id)).status).toBe("PUBLISHED");
    }
  );

  it("8 simultaneous archives: one succeeds, seven are INVALID_TRANSITION", async () => {
    const w = await pathWorld();
    const path = await w.makePath({ status: "PUBLISHED", courses: [await w.make()] });

    const results = await codes(
      Array.from({ length: 8 }, () => () => archiveLearningPath(w.admin.ctx, path.id))
    );

    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(results.filter((r) => r === "INVALID_TRANSITION")).toHaveLength(7);
    expect((await row(path.id)).status).toBe("ARCHIVED");
  });

  it("a publish that waits behind a competing archive sees the archive: it is a republish, judged now", async () => {
    const w = await pathWorld();
    const path = await w.makePath({ status: "PUBLISHED", courses: [await w.make()] });
    const before = (await row(path.id)).publishedAt;
    const lock = holdLock(path.id, async (tx) => {
      await tx.learningPath.update({ where: { id: path.id }, data: { status: "ARCHIVED" } });
    });
    await lock.isLocked;
    await new Promise((r) => setTimeout(r, 15));

    const publishing = errorCodeOf(() => publishLearningPath(w.admin.ctx, path.id));
    expect(await settledWithin(publishing, 150)).toBe(false);
    lock.release();
    await lock.done;

    expect(await publishing).toBeNull();
    const after = await row(path.id);
    expect(after.status).toBe("PUBLISHED");
    expect(after.publishedAt?.getTime()).toBeGreaterThan(before?.getTime() ?? 0);
  });

  it("an archive that waits behind a competing archive is refused, having read ARCHIVED after the lock", async () => {
    const w = await pathWorld();
    const path = await w.makePath({ status: "PUBLISHED", courses: [await w.make()] });
    const lock = holdLock(path.id, async (tx) => {
      await tx.learningPath.update({ where: { id: path.id }, data: { status: "ARCHIVED" } });
    });
    await lock.isLocked;

    const archiving = errorCodeOf(() => archiveLearningPath(w.admin.ctx, path.id));
    expect(await settledWithin(archiving, 150)).toBe(false);
    lock.release();
    await lock.done;

    expect(await archiving).toBe("INVALID_TRANSITION");
  });

  it("a lock on one path does not hold up another path's lifecycle", async () => {
    const w = await pathWorld();
    const busy = await w.makePath();
    const free = await w.makePath({ courses: [await w.make()] });
    const lock = holdLock(busy.id);
    await lock.isLocked;

    const publishing = publishLearningPath(w.admin.ctx, free.id);

    expect(await settledWithin(publishing, 2000)).toBe(true);
    lock.release();
    await lock.done;
    expect((await row(free.id)).status).toBe("PUBLISHED");
  });
});

describe("publishability is decided from the state after the lock, not before", () => {
  const changes = {
    "a course is archived": (courseId: string) => (tx: Tx) =>
      tx.course.update({ where: { id: courseId }, data: { status: "ARCHIVED" } }),
    "a course is unpublished": (courseId: string) => (tx: Tx) =>
      tx.course.update({ where: { id: courseId }, data: { status: "DRAFT" } }),
    "a course loses its published lessons": (courseId: string) => (tx: Tx) =>
      tx.lesson.updateMany({ where: { section: { courseId } }, data: { isPublished: false } }),
    "a course's lessons are archived": (courseId: string) => (tx: Tx) =>
      tx.lesson.updateMany({ where: { section: { courseId } }, data: { isArchived: true } }),
  };
  type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

  it.each(Object.entries(changes))(
    "the path reads as publishable, then %s while the publish waits for the lock: the publish is refused",
    async (_name, change) => {
      const w = await pathWorld();
      const [a, b] = await w.makeMany(2);
      if (!a || !b) throw new Error("fixture");
      const path = await w.makePath({ courses: [a, b] });

      // 1. It reads as publishable.
      // (Every course is available, and the path is not empty.)
      const { getLearningPathForAdmin } = await import("@/lib/domain/learning-path/paths");
      const seen = await getLearningPathForAdmin(w.admin.ctx, path.id);
      expect(seen.courses.length).toBeGreaterThan(0);
      expect(seen.courses.every((c) => c.blockReason === null)).toBe(true);

      // 2. Before the publish can mutate, another transaction changes a course.
      const lock = holdLock(path.id, async (tx) => {
        await change(b.id)(tx);
      });
      await lock.isLocked;

      // 3. The publish arrives and waits on the path lock.
      const publishing = errorCodeOf(() => publishLearningPath(w.admin.ctx, path.id));
      expect(await settledWithin(publishing, 150)).toBe(false);
      lock.release();
      await lock.done;

      // 4. It acquires the lock, evaluates the current state, and refuses.
      expect(await publishing).toBe("PATH_NOT_PUBLISHABLE");
      expect(await row(path.id)).toMatchObject({ status: "DRAFT", publishedAt: null });
      expect(await w.memberIds(path.id)).toEqual([a.id, b.id]);
    }
  );

  it("and the other way: a course fixed while the publish waits lets it through", async () => {
    const w = await pathWorld();
    const draft = await w.make({ status: "DRAFT" });
    const path = await w.makePath({ courses: [draft] });
    const lock = holdLock(path.id, async (tx) => {
      await tx.course.update({ where: { id: draft.id }, data: { status: "PUBLISHED" } });
    });
    await lock.isLocked;

    const publishing = errorCodeOf(() => publishLearningPath(w.admin.ctx, path.id));
    expect(await settledWithin(publishing, 150)).toBe(false);
    lock.release();
    await lock.done;

    expect(await publishing).toBeNull();
    expect((await row(path.id)).status).toBe("PUBLISHED");
  });

  it("a course added to the path while the publish waits is judged too", async () => {
    const w = await pathWorld();
    const good = await w.make();
    const draft = await w.make({ status: "DRAFT" });
    const path = await w.makePath({ courses: [good] });
    const lock = holdLock(path.id, async (tx) => {
      await tx.learningPathCourse.create({
        data: { pathId: path.id, courseId: draft.id, position: 2 },
      });
    });
    await lock.isLocked;

    const publishing = errorCodeOf(() => publishLearningPath(w.admin.ctx, path.id));
    expect(await settledWithin(publishing, 150)).toBe(false);
    lock.release();
    await lock.done;

    expect(await publishing).toBe("PATH_NOT_PUBLISHABLE");
    expect((await row(path.id)).status).toBe("DRAFT");
  });

  it("a publish racing a course change with no lock held ends in a state that matches what it saw: published only if every course was fine when it looked", async () => {
    const w = await pathWorld();
    const [a, b] = await w.makeMany(2);
    if (!a || !b) throw new Error("fixture");
    const path = await w.makePath({ courses: [a, b] });

    const [result] = await Promise.all([
      errorCodeOf(() => publishLearningPath(w.admin.ctx, path.id)),
      db.course.update({ where: { id: b.id }, data: { status: "ARCHIVED" } }),
    ]);

    // Course rows are not locked (drift is accepted), so both outcomes are legal;
    // what must hold is that the answer and the stored status agree.
    const after = await row(path.id);
    expect(after.status).toBe(result === null ? "PUBLISHED" : "DRAFT");
    expect(["PATH_NOT_PUBLISHABLE", null]).toContain(result);
    expect(await w.memberIds(path.id)).toEqual([a.id, b.id]);
  });
});
