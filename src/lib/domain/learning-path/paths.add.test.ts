import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { errorCodeOf, pathWorld } from "@/lib/domain/learning-path/__test__/pathWorld";
import { LEARNING_PATH_MAX_COURSES } from "@/lib/domain/learning-path/constants";
import { addCourseToLearningPath } from "@/lib/domain/learning-path/paths";
import { PathNotPublishableError } from "@/lib/domain/learning-path/types";

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

const add = (
  w: { admin: { ctx: Parameters<typeof addCourseToLearningPath>[0] } },
  pathId: unknown,
  courseId: unknown
) => addCourseToLearningPath(w.admin.ctx, pathId, { courseId });

describe("addCourseToLearningPath — position", () => {
  it("puts the first course at position 1 and returns the path", async () => {
    const w = await pathWorld();
    const course = await w.make();
    const path = await w.makePath();

    const detail = await add(w, path.id, course.id);

    expect(detail.courses).toEqual([
      expect.objectContaining({ courseId: course.id, position: 1, slug: course.slug }),
    ]);
    expect(await w.members(path.id)).toEqual([{ courseId: course.id, position: 1 }]);
  });

  it("appends each course at the end", async () => {
    const w = await pathWorld();
    const [a, b, c] = await w.makeMany(3);
    if (!a || !b || !c) throw new Error("fixture");
    const path = await w.makePath();

    await add(w, path.id, a.id);
    await add(w, path.id, b.id);
    const detail = await add(w, path.id, c.id);

    expect(detail.courses.map((x) => [x.courseId, x.position])).toEqual([
      [a.id, 1],
      [b.id, 2],
      [c.id, 3],
    ]);
  });

  it("goes one past the largest position held, even when positions have gaps", async () => {
    const w = await pathWorld();
    const [a, b, fresh] = await w.makeMany(3);
    if (!a || !b || !fresh) throw new Error("fixture");
    const path = await w.makePath();
    await db.learningPathCourse.createMany({
      data: [
        { pathId: path.id, courseId: a.id, position: 1 },
        { pathId: path.id, courseId: b.id, position: 5 },
      ],
    });

    await add(w, path.id, fresh.id);

    expect(await w.members(path.id)).toContainEqual({ courseId: fresh.id, position: 6 });
  });

  it("never takes a position from the client", async () => {
    const w = await pathWorld();
    const course = await w.make();
    const path = await w.makePath();

    const code = await errorCodeOf(() =>
      addCourseToLearningPath(w.admin.ctx, path.id, { courseId: course.id, position: 1 })
    );

    expect(code).toBe("INVALID_INPUT");
    expect(await w.members(path.id)).toEqual([]);
  });

  it("moves the path's updatedAt", async () => {
    const w = await pathWorld();
    const path = await w.makePath();
    const before = (await db.learningPath.findUniqueOrThrow({ where: { id: path.id } })).updatedAt;
    await new Promise((r) => setTimeout(r, 15));

    const detail = await add(w, path.id, (await w.make()).id);

    expect(detail.updatedAt.getTime()).toBeGreaterThan(before.getTime());
  });
});

describe("addCourseToLearningPath — which courses", () => {
  it("a DRAFT path takes a DRAFT course, a PUBLISHED course and a published course with no lessons", async () => {
    const w = await pathWorld();
    const draft = await w.make({ status: "DRAFT" });
    const live = await w.make();
    const bare = await w.make({ lessons: false });
    const path = await w.makePath();

    for (const course of [draft, live, bare]) await add(w, path.id, course.id);

    expect(await w.memberIds(path.id)).toEqual([draft.id, live.id, bare.id]);
  });

  it("refuses an ARCHIVED course of the tenant with COURSE_ARCHIVED, for a draft and a published path alike", async () => {
    const w = await pathWorld();
    const archived = await w.make({ status: "ARCHIVED" });
    const draftPath = await w.makePath();
    const livePath = await w.makePath({ status: "PUBLISHED", courses: [await w.make()] });

    expect(await errorCodeOf(() => add(w, draftPath.id, archived.id))).toBe("COURSE_ARCHIVED");
    expect(await errorCodeOf(() => add(w, livePath.id, archived.id))).toBe("COURSE_ARCHIVED");
    expect(await w.memberIds(draftPath.id)).toEqual([]);
  });

  it("tenantless, another tenant's and unknown courses are all COURSE_NOT_FOUND, archived or not", async () => {
    const w = await pathWorld();
    const path = await w.makePath();
    const candidates = [
      await w.makeTenantless(),
      (await w.makeForeign()).id,
      (await w.makeForeign({ status: "ARCHIVED" })).id,
      "does-not-exist",
    ].map((c) => (typeof c === "string" ? c : c.id));

    for (const id of candidates) {
      expect(await errorCodeOf(() => add(w, path.id, id)), id).toBe("COURSE_NOT_FOUND");
    }
    expect(await w.members(path.id)).toEqual([]);
  });

  it("refuses a course already in the path with DUPLICATE, and there is still one row", async () => {
    const w = await pathWorld();
    const course = await w.make();
    const path = await w.makePath({ courses: [course] });

    expect(await errorCodeOf(() => add(w, path.id, course.id))).toBe("DUPLICATE");
    expect(await w.members(path.id)).toEqual([{ courseId: course.id, position: 1 }]);
  });

  it("the same course may be in two paths", async () => {
    const w = await pathWorld();
    const course = await w.make();
    const one = await w.makePath();
    const two = await w.makePath();

    await add(w, one.id, course.id);
    await add(w, two.id, course.id);

    expect(await db.learningPathCourse.count({ where: { courseId: course.id } })).toBe(2);
  });
});

describe("addCourseToLearningPath — the limit", () => {
  it("takes the 20th course and refuses the 21st with LIMIT_REACHED", async () => {
    const w = await pathWorld();
    const courses = await w.makeMany(LEARNING_PATH_MAX_COURSES + 1);
    const path = await w.makePath({ courses: courses.slice(0, LEARNING_PATH_MAX_COURSES - 1) });

    const detail = await add(w, path.id, courses[LEARNING_PATH_MAX_COURSES - 1]?.id);
    expect(detail.courses).toHaveLength(LEARNING_PATH_MAX_COURSES);

    expect(await errorCodeOf(() => add(w, path.id, courses[LEARNING_PATH_MAX_COURSES]?.id))).toBe(
      "LIMIT_REACHED"
    );
    expect(await w.members(path.id)).toHaveLength(LEARNING_PATH_MAX_COURSES);
  });
});

describe("addCourseToLearningPath — a published path", () => {
  it("takes a published course that can be completed", async () => {
    const w = await pathWorld();
    const path = await w.makePath({ status: "PUBLISHED", courses: [await w.make()] });
    const course = await w.make();

    const detail = await add(w, path.id, course.id);

    expect(detail.courses.map((c) => c.courseId)).toContain(course.id);
    expect(detail.status).toBe("PUBLISHED");
  });

  it.each([
    ["a DRAFT course", { status: "DRAFT" as const }, "NOT_PUBLISHED"],
    ["a published course with no published lesson", { lessons: false }, "NO_PUBLISHED_LESSON"],
  ])("refuses %s with PATH_NOT_PUBLISHABLE, naming why", async (_name, overrides, reason) => {
    const w = await pathWorld();
    const path = await w.makePath({ status: "PUBLISHED", courses: [await w.make()] });
    const course = await w.make(overrides);

    let caught: unknown;
    try {
      await add(w, path.id, course.id);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PathNotPublishableError);
    expect((caught as PathNotPublishableError).problems).toEqual([
      { kind: "COURSE", courseId: course.id, title: course.title, reason },
    ]);
    expect(await w.members(path.id)).toHaveLength(1);
  });

  it("does not count an archived lesson as something to complete", async () => {
    const w = await pathWorld();
    const path = await w.makePath({ status: "PUBLISHED", courses: [await w.make()] });
    const course = await w.make();
    await db.lesson.updateMany({
      where: { section: { courseId: course.id } },
      data: { isArchived: true },
    });

    expect(await errorCodeOf(() => add(w, path.id, course.id))).toBe("PATH_NOT_PUBLISHABLE");
  });
});

describe("addCourseToLearningPath — the path", () => {
  it("refuses an ARCHIVED path with PATH_ARCHIVED", async () => {
    const w = await pathWorld();
    const path = await w.makePath({ status: "ARCHIVED" });
    const course = await w.make();

    expect(await errorCodeOf(() => add(w, path.id, course.id))).toBe("PATH_ARCHIVED");
    expect(await w.members(path.id)).toEqual([]);
  });

  it("another tenant's path, an unknown path and a malformed id are NOT_FOUND, and the other path is untouched", async () => {
    const w = await pathWorld();
    const other = await pathWorld();
    const theirs = await other.makePath();
    const course = await w.make();

    for (const id of [theirs.id, "does-not-exist", "bad id!", null]) {
      expect(await errorCodeOf(() => add(w, id, course.id))).toBe("NOT_FOUND");
    }
    expect(await other.members(theirs.id)).toEqual([]);
  });

  it("cannot be used to put this tenant's course into another tenant's path", async () => {
    const w = await pathWorld();
    const other = await pathWorld();
    const theirs = await other.makePath();
    const mine = await w.make();

    await errorCodeOf(() => add(w, theirs.id, mine.id));
    await errorCodeOf(() => add(other, theirs.id, mine.id));

    expect(await other.members(theirs.id)).toEqual([]);
  });
});

describe("addCourseToLearningPath — the request", () => {
  it.each([
    ["missing courseId", {}],
    ["a numeric courseId", { courseId: 5 }],
    ["a malformed courseId", { courseId: "bad id!" }],
    ["a forged tenantId", { courseId: "x", tenantId: "t" }],
    ["a forged createdById", { courseId: "x", createdById: "u" }],
    ["a forged status", { courseId: "x", status: "PUBLISHED" }],
    ["a forged id", { courseId: "x", id: "i" }],
    ["an unknown key", { courseId: "x", mystery: 1 }],
    ["a courseIds list", { courseIds: ["x"] }],
    ["null", null],
    ["a string", "x"],
    ["an array", ["x"]],
  ])("refuses %s with INVALID_INPUT", async (_name, body) => {
    const w = await pathWorld();
    const path = await w.makePath();

    expect(await errorCodeOf(() => addCourseToLearningPath(w.admin.ctx, path.id, body))).toBe(
      "INVALID_INPUT"
    );
    expect(await w.members(path.id)).toEqual([]);
  });

  it("refuses everyone who is not an ORG_ADMIN of a tenant, before reading the id or the body", async () => {
    const w = await pathWorld();
    const course = await w.make();
    const path = await w.makePath();

    for (const [name, ctx] of w.outsiders) {
      expect(
        await errorCodeOf(() => addCourseToLearningPath(ctx, path.id, { courseId: course.id })),
        name
      ).toBe("FORBIDDEN");
      expect(await errorCodeOf(() => addCourseToLearningPath(ctx, "!", "junk")), name).toBe(
        "FORBIDDEN"
      );
    }
    expect(await w.members(path.id)).toEqual([]);
  });
});

describe("addCourseToLearningPath — the unique index is the last guard", () => {
  it("a duplicate that gets past the membership check is DUPLICATE, not a database error", async () => {
    const w = await pathWorld();
    const course = await w.make();
    const path = await w.makePath({ courses: [course] });
    const real = db.$transaction.bind(db);
    // Blind the membership read, as a race that beat the lock would.
    vi.spyOn(db, "$transaction").mockImplementation(((fn: (tx: unknown) => unknown) =>
      real(async (tx) => {
        const blind = new Proxy(tx, {
          get(target, prop, receiver) {
            if (prop !== "learningPathCourse") return Reflect.get(target, prop, receiver);
            const delegate = target.learningPathCourse;
            return new Proxy(delegate, {
              get: (d, method) =>
                method === "findMany"
                  ? async () => []
                  : (d as unknown as Record<string | symbol, unknown>)[method],
            });
          },
        });
        return fn(blind);
      })) as never);

    expect(await errorCodeOf(() => add(w, path.id, course.id))).toBe("DUPLICATE");
    expect(await w.members(path.id)).toEqual([{ courseId: course.id, position: 1 }]);
  });

  it.each([
    ["P2002", "DUPLICATE"],
    ["P2003", "COURSE_NOT_FOUND"],
  ])("maps the database's %s to %s", async (code, expected) => {
    const w = await pathWorld();
    const path = await w.makePath();
    vi.spyOn(db, "$transaction").mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("driver detail with a table name", {
        code,
        clientVersion: "test",
      })
    );

    expect(await errorCodeOf(() => add(w, path.id, "some-course"))).toBe(expected);
  });

  it("passes any other database error on untouched, for the route to answer generically", async () => {
    const w = await pathWorld();
    const path = await w.makePath();
    const boom = new Prisma.PrismaClientKnownRequestError("other", {
      code: "P2028",
      clientVersion: "test",
    });
    vi.spyOn(db, "$transaction").mockRejectedValueOnce(boom);

    await expect(add(w, path.id, "some-course")).rejects.toBe(boom);
  });
});
