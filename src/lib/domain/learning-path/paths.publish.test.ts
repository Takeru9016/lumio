import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { errorCodeOf, pathWorld } from "@/lib/domain/learning-path/__test__/pathWorld";
import * as pathsModule from "@/lib/domain/learning-path/paths";
import {
  addCourseToLearningPath,
  archiveLearningPath,
  createLearningPath,
  publishLearningPath,
} from "@/lib/domain/learning-path/paths";
import { PathNotPublishableError } from "@/lib/domain/learning-path/types";

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

const row = (id: string) => db.learningPath.findUniqueOrThrow({ where: { id } });

async function problemsOf(call: () => Promise<unknown>) {
  try {
    await call();
  } catch (err) {
    if (err instanceof PathNotPublishableError) return err.problems;
    throw err;
  }
  return null;
}

describe("publishLearningPath — a publishable DRAFT", () => {
  it("publishes it, stamping publishedAt with now, and returns the path", async () => {
    const w = await pathWorld();
    const [a, b] = await w.makeMany(2);
    if (!a || !b) throw new Error("fixture");
    const path = await w.makePath({ title: "Journey", courses: [a, b] });
    const before = Date.now();

    const detail = await publishLearningPath(w.admin.ctx, path.id);

    expect(detail).toMatchObject({ id: path.id, status: "PUBLISHED", title: "Journey" });
    expect(detail.publishedAt).toBeInstanceOf(Date);
    expect(detail.publishedAt?.getTime()).toBeGreaterThanOrEqual(before - 5);
    expect(detail.publishedAt?.getTime()).toBeLessThanOrEqual(Date.now() + 5);
    expect(detail.courses.map((c) => c.courseId)).toEqual([a.id, b.id]);
    expect(await row(path.id)).toMatchObject({ status: "PUBLISHED" });
  });

  it("publishes a multi-course path of up to the maximum", async () => {
    const w = await pathWorld();
    const path = await w.makePath({ courses: await w.makeMany(20) });

    expect((await publishLearningPath(w.admin.ctx, path.id)).courses).toHaveLength(20);
  });

  it("changes nothing but the status, publishedAt and updatedAt: not the courses, their order, the text or the creator", async () => {
    const w = await pathWorld();
    const courses = await w.makeMany(3);
    const path = await w.makePath({ title: "Keep", courses });
    await db.learningPath.update({ where: { id: path.id }, data: { description: "Keep too" } });
    const pathBefore = await row(path.id);
    const membersBefore = await db.learningPathCourse.findMany({
      where: { pathId: path.id },
      orderBy: { position: "asc" },
    });
    await new Promise((r) => setTimeout(r, 15));

    await publishLearningPath(w.admin.ctx, path.id);

    const pathAfter = await row(path.id);
    const { status, publishedAt, updatedAt, ...rest } = pathAfter;
    const { status: s0, publishedAt: p0, updatedAt: u0, ...restBefore } = pathBefore;
    expect(rest).toEqual(restBefore);
    expect(status).toBe("PUBLISHED");
    expect(publishedAt).not.toBeNull();
    expect(updatedAt.getTime()).toBeGreaterThan(u0.getTime());
    expect(s0).toBe("DRAFT");
    expect(p0).toBeNull();
    expect(
      await db.learningPathCourse.findMany({
        where: { pathId: path.id },
        orderBy: { position: "asc" },
      })
    ).toEqual(membersBefore);
  });
});

describe("publishLearningPath — a path that is not publishable", () => {
  it("refuses an empty path with NO_COURSES, and leaves it a DRAFT", async () => {
    const w = await pathWorld();
    const path = await w.makePath();

    expect(await problemsOf(() => publishLearningPath(w.admin.ctx, path.id))).toEqual([
      { kind: "NO_COURSES" },
    ]);
    expect(await row(path.id)).toMatchObject({ status: "DRAFT", publishedAt: null });
  });

  it.each([
    ["a DRAFT course", { status: "DRAFT" as const }, "NOT_PUBLISHED"],
    ["an ARCHIVED course", { status: "ARCHIVED" as const }, "ARCHIVED"],
    ["a course with no published lesson", { lessons: false }, "NO_PUBLISHED_LESSON"],
  ])("refuses a path holding %s, naming it", async (_name, overrides, reason) => {
    const w = await pathWorld();
    const good = await w.make();
    const bad = await w.make(overrides);
    const path = await w.makePath({ courses: [good, bad] });

    expect(await problemsOf(() => publishLearningPath(w.admin.ctx, path.id))).toEqual([
      { kind: "COURSE", courseId: bad.id, title: bad.title, reason },
    ]);
    expect(await row(path.id)).toMatchObject({ status: "DRAFT", publishedAt: null });
  });

  it("does not count an archived lesson as something to complete", async () => {
    const w = await pathWorld();
    const course = await w.make();
    await db.lesson.updateMany({
      where: { section: { courseId: course.id } },
      data: { isArchived: true },
    });
    const path = await w.makePath({ courses: [course] });

    expect(await errorCodeOf(() => publishLearningPath(w.admin.ctx, path.id))).toBe(
      "PATH_NOT_PUBLISHABLE"
    );
  });

  it("names every blocking course, in path order", async () => {
    const w = await pathWorld();
    const [good, draft, archived, bare] = await Promise.all([
      w.make(),
      w.make({ status: "DRAFT" }),
      w.make({ status: "ARCHIVED" }),
      w.make({ lessons: false }),
    ]);
    const path = await w.makePath({ courses: [draft, good, archived, bare] });

    const problems = await problemsOf(() => publishLearningPath(w.admin.ctx, path.id));

    expect(problems?.map((p) => (p.kind === "COURSE" ? [p.courseId, p.reason] : p.kind))).toEqual([
      [draft.id, "NOT_PUBLISHED"],
      [archived.id, "ARCHIVED"],
      [bare.id, "NO_PUBLISHED_LESSON"],
    ]);
  });

  it("names the blockers in path order however the membership rows were stored", async () => {
    const w = await pathWorld();
    const [first, second, third] = await Promise.all([
      w.make({ status: "DRAFT" }),
      w.make({ status: "ARCHIVED" }),
      w.make({ lessons: false }),
    ]);
    if (!first || !second || !third) throw new Error("fixture");
    const path = await w.makePath();
    // Stored last-position-first, so storage order is the reverse of path order.
    for (const [course, position] of [
      [third, 3],
      [second, 2],
      [first, 1],
    ] as const) {
      await db.learningPathCourse.create({
        data: { pathId: path.id, courseId: course.id, position },
      });
    }

    const problems = await problemsOf(() => publishLearningPath(w.admin.ctx, path.id));

    expect(problems?.map((p) => (p.kind === "COURSE" ? p.courseId : p.kind))).toEqual([
      first.id,
      second.id,
      third.id,
    ]);
  });

  it("names the blockers in path order even when the database hands the members back in another order", async () => {
    const w = await pathWorld();
    const [first, second, third] = await Promise.all([
      w.make({ status: "DRAFT" }),
      w.make({ status: "ARCHIVED" }),
      w.make({ lessons: false }),
    ]);
    if (!first || !second || !third) throw new Error("fixture");
    const path = await w.makePath({ courses: [first, second, third] });
    const real = db.$transaction.bind(db);
    // Reverse what the membership read returns: no ORDER BY promises an order.
    vi.spyOn(db, "$transaction").mockImplementation(((fn: (tx: unknown) => unknown) =>
      real(async (tx) => {
        const shuffled = new Proxy(tx, {
          get(target, prop, receiver) {
            if (prop !== "learningPathCourse") return Reflect.get(target, prop, receiver);
            return new Proxy(target.learningPathCourse, {
              get: (delegate, method) =>
                method === "findMany"
                  ? async (args: unknown) => (await delegate.findMany(args as never)).reverse()
                  : (delegate as unknown as Record<string | symbol, unknown>)[method],
            });
          },
        });
        return fn(shuffled);
      })) as never);

    const problems = await problemsOf(() => publishLearningPath(w.admin.ctx, path.id));

    expect(problems?.map((p) => (p.kind === "COURSE" ? p.courseId : p.kind))).toEqual([
      first.id,
      second.id,
      third.id,
    ]);
  });

  it("never lets a foreign or tenantless course into a published path, even one forced into the table", async () => {
    const w = await pathWorld();
    const foreign = await w.makeForeign();
    const open = await w.makeTenantless();
    const path = await w.makePath({ courses: [await w.make()] });
    await db.learningPathCourse.createMany({
      data: [
        { pathId: path.id, courseId: foreign.id, position: 2 },
        { pathId: path.id, courseId: open.id, position: 3 },
      ],
    });

    const problems = await problemsOf(() => publishLearningPath(w.admin.ctx, path.id));

    expect(problems?.map((p) => (p.kind === "COURSE" ? [p.courseId, p.reason] : p.kind))).toEqual([
      [foreign.id, "WRONG_TENANT"],
      [open.id, "WRONG_TENANT"],
    ]);
    expect((await row(path.id)).status).toBe("DRAFT");
  });

  it("refuses a path whose title is no longer valid", async () => {
    const w = await pathWorld();
    const path = await w.makePath({ courses: [await w.make()] });
    await db.learningPath.update({ where: { id: path.id }, data: { title: "  " } });

    expect(await problemsOf(() => publishLearningPath(w.admin.ctx, path.id))).toEqual([
      { kind: "INVALID_TITLE" },
    ]);
  });

  it("never repairs the path: no course is added, removed or moved, and updatedAt is not touched", async () => {
    const w = await pathWorld();
    const [good, bad] = await Promise.all([w.make(), w.make({ status: "ARCHIVED" })]);
    const path = await w.makePath({ courses: [good, bad] });
    const before = await row(path.id);
    const members = await w.members(path.id);

    await errorCodeOf(() => publishLearningPath(w.admin.ctx, path.id));

    expect(await row(path.id)).toEqual(before);
    expect(await w.members(path.id)).toEqual(members);
  });
});

describe("publishLearningPath — the state machine", () => {
  it("refuses a PUBLISHED path with INVALID_TRANSITION and leaves publishedAt and updatedAt alone", async () => {
    const w = await pathWorld();
    const path = await w.makePath({ status: "PUBLISHED", courses: [await w.make()] });
    const before = await row(path.id);

    expect(await errorCodeOf(() => publishLearningPath(w.admin.ctx, path.id))).toBe(
      "INVALID_TRANSITION"
    );
    expect(await row(path.id)).toEqual(before);
  });

  it("decides the transition before publishability: a PUBLISHED path is INVALID_TRANSITION even if its courses drifted", async () => {
    const w = await pathWorld();
    const course = await w.make();
    const path = await w.makePath({ status: "PUBLISHED", courses: [course] });
    await w.archive(course.id);

    expect(await errorCodeOf(() => publishLearningPath(w.admin.ctx, path.id))).toBe(
      "INVALID_TRANSITION"
    );
  });

  it("republishes an ARCHIVED path that is publishable now, with a new publishedAt", async () => {
    const w = await pathWorld();
    const course = await w.make();
    const first = new Date("2026-01-01T00:00:00.000Z");
    const path = await w.makePath({ status: "ARCHIVED", courses: [course] });
    await db.learningPath.update({ where: { id: path.id }, data: { publishedAt: first } });

    const detail = await publishLearningPath(w.admin.ctx, path.id);

    expect(detail.status).toBe("PUBLISHED");
    expect(detail.publishedAt?.getTime()).toBeGreaterThan(first.getTime());
    expect(await w.memberIds(path.id)).toEqual([course.id]);
  });

  it("refuses to republish an ARCHIVED path whose courses are not publishable now, and it stays ARCHIVED", async () => {
    const w = await pathWorld();
    const course = await w.make();
    const path = await w.makePath({ status: "ARCHIVED", courses: [course] });
    await w.archive(course.id);
    const before = await row(path.id);

    expect(await problemsOf(() => publishLearningPath(w.admin.ctx, path.id))).toEqual([
      { kind: "COURSE", courseId: course.id, title: course.title, reason: "ARCHIVED" },
    ]);
    expect(await row(path.id)).toEqual(before);
  });

  it("exposes no way to set an arbitrary status or to go back to DRAFT", () => {
    const names = Object.keys(pathsModule);

    expect(names).toEqual(expect.arrayContaining(["publishLearningPath", "archiveLearningPath"]));
    expect(names.filter((n) => /status|unpublish|draft|transition/i.test(n))).toEqual([]);
  });
});

describe("publish → archive → publish", () => {
  it("runs the whole life of a path, judging each publication on the courses as they are then", async () => {
    const w = await pathWorld();
    const [a, b] = await w.makeMany(2);
    if (!a || !b) throw new Error("fixture");
    const ctx = w.admin.ctx;

    const created = await createLearningPath(ctx, { title: "Journey" });
    await addCourseToLearningPath(ctx, created.id, { courseId: a.id });
    await addCourseToLearningPath(ctx, created.id, { courseId: b.id });
    const first = await publishLearningPath(ctx, created.id);
    await new Promise((r) => setTimeout(r, 15));
    const archived = await archiveLearningPath(ctx, created.id);
    const second = await publishLearningPath(ctx, created.id);

    expect([first.status, archived.status, second.status]).toEqual([
      "PUBLISHED",
      "ARCHIVED",
      "PUBLISHED",
    ]);
    expect(archived.publishedAt).toEqual(first.publishedAt);
    expect(second.publishedAt?.getTime()).toBeGreaterThan(first.publishedAt?.getTime() ?? 0);
    expect(second.courses.map((c) => [c.courseId, c.position])).toEqual([
      [a.id, 1],
      [b.id, 2],
    ]);

    await archiveLearningPath(ctx, created.id);
    await w.archive(b.id);
    expect(await problemsOf(() => publishLearningPath(ctx, created.id))).toEqual([
      { kind: "COURSE", courseId: b.id, title: b.title, reason: "ARCHIVED" },
    ]);
    expect((await row(created.id)).status).toBe("ARCHIVED");
    expect(await w.memberIds(created.id)).toEqual([a.id, b.id]);
  });

  it("only current state decides: a course fixed after a refusal lets the republish through", async () => {
    const w = await pathWorld();
    const course = await w.make({ status: "DRAFT" });
    const path = await w.makePath({ status: "ARCHIVED", courses: [course] });
    expect(await errorCodeOf(() => publishLearningPath(w.admin.ctx, path.id))).toBe(
      "PATH_NOT_PUBLISHABLE"
    );

    await db.course.update({ where: { id: course.id }, data: { status: "PUBLISHED" } });

    expect((await publishLearningPath(w.admin.ctx, path.id)).status).toBe("PUBLISHED");
  });
});

describe("publishLearningPath — the path and the caller", () => {
  it("another tenant's path, an unknown path and a malformed id are the same NOT_FOUND, and the other path is untouched", async () => {
    const w = await pathWorld();
    const other = await pathWorld();
    const theirs = await other.makePath({ courses: [await other.make()] });

    for (const id of [theirs.id, "does-not-exist", "bad id!", "", 5, null, undefined]) {
      expect(await errorCodeOf(() => publishLearningPath(w.admin.ctx, id))).toBe("NOT_FOUND");
    }
    expect(await row(theirs.id)).toMatchObject({ status: "DRAFT", publishedAt: null });
  });

  it("refuses everyone who is not an ORG_ADMIN of a tenant, before reading the id", async () => {
    const w = await pathWorld();
    const path = await w.makePath({ courses: [await w.make()] });

    for (const [name, ctx] of w.outsiders) {
      expect(await errorCodeOf(() => publishLearningPath(ctx, path.id)), name).toBe("FORBIDDEN");
      expect(await errorCodeOf(() => publishLearningPath(ctx, "!!")), name).toBe("FORBIDDEN");
    }
    expect((await row(path.id)).status).toBe("DRAFT");
  });
});
