import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { errorCodeOf, pathWorld } from "@/lib/domain/learning-path/__test__/pathWorld";
import {
  removeCourseFromLearningPath,
  reorderLearningPath,
} from "@/lib/domain/learning-path/paths";

afterAll(async () => {
  await db.$disconnect();
});

const reorder = (
  w: { admin: { ctx: Parameters<typeof reorderLearningPath>[0] } },
  pathId: unknown,
  courseIds: unknown
) => reorderLearningPath(w.admin.ctx, pathId, { courseIds });

async function fourCourses() {
  const w = await pathWorld();
  const [a, b, c, d] = await w.makeMany(4);
  if (!a || !b || !c || !d) throw new Error("fixture");
  const path = await w.makePath({ courses: [a, b, c, d] });
  return { w, a, b, c, d, path };
}

describe("reorderLearningPath — a valid order", () => {
  it("assigns positions 1..n in the requested order and returns the path in that order", async () => {
    const { w, a, b, c, d, path } = await fourCourses();

    const detail = await reorder(w, path.id, [c.id, a.id, d.id, b.id]);

    expect(detail.courses.map((x) => [x.courseId, x.position])).toEqual([
      [c.id, 1],
      [a.id, 2],
      [d.id, 3],
      [b.id, 4],
    ]);
    expect(await w.members(path.id)).toEqual([
      { courseId: c.id, position: 1 },
      { courseId: a.id, position: 2 },
      { courseId: d.id, position: 3 },
      { courseId: b.id, position: 4 },
    ]);
  });

  it("is a no-op for the order it already has", async () => {
    const { w, a, b, c, d, path } = await fourCourses();

    await reorder(w, path.id, [a.id, b.id, c.id, d.id]);

    expect(await w.memberIds(path.id)).toEqual([a.id, b.id, c.id, d.id]);
  });

  it("turns gaps and ties into exactly 1..n", async () => {
    const w = await pathWorld();
    const [a, b, c] = await w.makeMany(3);
    if (!a || !b || !c) throw new Error("fixture");
    const path = await w.makePath();
    await db.learningPathCourse.createMany({
      data: [
        { pathId: path.id, courseId: a.id, position: 4 },
        { pathId: path.id, courseId: b.id, position: 4 },
        { pathId: path.id, courseId: c.id, position: 20 },
      ],
    });

    await reorder(w, path.id, [b.id, c.id, a.id]);

    expect((await w.members(path.id)).map((m) => m.position)).toEqual([1, 2, 3]);
    expect(await w.memberIds(path.id)).toEqual([b.id, c.id, a.id]);
  });

  it("works on a PUBLISHED path, even one whose courses have drifted", async () => {
    const w = await pathWorld();
    const [a, b] = await w.makeMany(2);
    if (!a || !b) throw new Error("fixture");
    const path = await w.makePath({ status: "PUBLISHED", courses: [a, b] });
    await w.archive(b.id);

    const detail = await reorder(w, path.id, [b.id, a.id]);

    expect(detail.courses.map((c) => c.courseId)).toEqual([b.id, a.id]);
    expect(detail.status).toBe("PUBLISHED");
  });

  it("never creates or deletes a membership: the same rows, only renumbered", async () => {
    const { w, a, b, c, d, path } = await fourCourses();
    const before = await db.learningPathCourse.findMany({
      where: { pathId: path.id },
      orderBy: { courseId: "asc" },
      select: { id: true, courseId: true, createdAt: true },
    });

    await reorder(w, path.id, [d.id, c.id, b.id, a.id]);

    const after = await db.learningPathCourse.findMany({
      where: { pathId: path.id },
      orderBy: { courseId: "asc" },
      select: { id: true, courseId: true, createdAt: true },
    });
    expect(after).toEqual(before);
  });

  it("moves the path's updatedAt but not its status or title", async () => {
    const { w, a, b, c, d, path } = await fourCourses();
    const before = await db.learningPath.findUniqueOrThrow({ where: { id: path.id } });
    await new Promise((r) => setTimeout(r, 15));

    await reorder(w, path.id, [d.id, c.id, b.id, a.id]);

    const after = await db.learningPath.findUniqueOrThrow({ where: { id: path.id } });
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    expect({ title: after.title, status: after.status }).toEqual({
      title: before.title,
      status: before.status,
    });
  });
});

describe("reorderLearningPath — a request that is wrong", () => {
  it.each([
    ["empty", () => []],
    ["a duplicate id", (x: string[]) => [x[0], x[0], x[1], x[2]]],
    ["not a list", () => "abc"],
    ["null", () => null],
    ["a list of numbers", () => [1, 2, 3, 4]],
    ["a list with a malformed id", (x: string[]) => [x[0], "bad id!", x[1], x[2]]],
    ["a list with a nested list", (x: string[]) => [[x[0]], x[1], x[2], x[3]]],
  ])("refuses %s with INVALID_INPUT and changes nothing", async (_name, build) => {
    const { w, a, b, c, d, path } = await fourCourses();

    const code = await errorCodeOf(() => reorder(w, path.id, build([a.id, b.id, c.id, d.id])));

    expect(code).toBe("INVALID_INPUT");
    expect(await w.memberIds(path.id)).toEqual([a.id, b.id, c.id, d.id]);
  });

  it.each([
    ["the courseIds key missing", {}],
    ["positions instead of ids", { positions: [1, 2] }],
    ["an extra key beside courseIds", { courseIds: ["x"], positions: [1] }],
    ["a forged tenantId", { courseIds: ["x"], tenantId: "t" }],
    ["null", null],
    ["a list", ["x"]],
    ["a string", "x"],
  ])("refuses a body with %s with INVALID_INPUT", async (_name, body) => {
    const { w, path, a, b, c, d } = await fourCourses();

    expect(await errorCodeOf(() => reorderLearningPath(w.admin.ctx, path.id, body))).toBe(
      "INVALID_INPUT"
    );
    expect(await w.memberIds(path.id)).toEqual([a.id, b.id, c.id, d.id]);
  });

  it("an empty path cannot be reordered", async () => {
    const w = await pathWorld();
    const path = await w.makePath();

    expect(await errorCodeOf(() => reorder(w, path.id, []))).toBe("INVALID_INPUT");
  });
});

describe("reorderLearningPath — a list that is stale", () => {
  it.each([
    ["a course missing", (x: string[]) => [x[0], x[1], x[2]]],
    ["an unknown course", (x: string[]) => [x[0], x[1], x[2], "does-not-exist"]],
    ["an extra unknown course", (x: string[]) => [...x, "does-not-exist"]],
  ])("refuses %s with STALE_ORDER and changes nothing", async (_name, build) => {
    const { w, a, b, c, d, path } = await fourCourses();

    const code = await errorCodeOf(() => reorder(w, path.id, build([a.id, b.id, c.id, d.id])));

    expect(code).toBe("STALE_ORDER");
    expect(await w.members(path.id)).toEqual([
      { courseId: a.id, position: 1 },
      { courseId: b.id, position: 2 },
      { courseId: c.id, position: 3 },
      { courseId: d.id, position: 4 },
    ]);
  });

  it("a course of the tenant that is not in the path, and a course of another tenant, are the same STALE_ORDER", async () => {
    const { w, a, b, c, d, path } = await fourCourses();
    const outside = await w.make();
    const foreign = await w.makeForeign();

    for (const extra of [outside.id, foreign.id]) {
      expect(await errorCodeOf(() => reorder(w, path.id, [a.id, b.id, c.id, extra]))).toBe(
        "STALE_ORDER"
      );
      expect(await errorCodeOf(() => reorder(w, path.id, [a.id, b.id, c.id, d.id, extra]))).toBe(
        "STALE_ORDER"
      );
    }
    expect(await db.learningPathCourse.count({ where: { pathId: path.id } })).toBe(4);
  });

  it("a list made before a removal is STALE_ORDER after it", async () => {
    const { w, a, b, c, d, path } = await fourCourses();
    const seen = [a.id, b.id, c.id, d.id];

    await removeCourseFromLearningPath(w.admin.ctx, path.id, c.id);

    expect(await errorCodeOf(() => reorder(w, path.id, [d.id, c.id, b.id, a.id]))).toBe(
      "STALE_ORDER"
    );
    expect(await errorCodeOf(() => reorder(w, path.id, seen))).toBe("STALE_ORDER");
    expect(await w.members(path.id)).toEqual([
      { courseId: a.id, position: 1 },
      { courseId: b.id, position: 2 },
      { courseId: d.id, position: 3 },
    ]);
  });
});

describe("reorderLearningPath — the path", () => {
  it("refuses an ARCHIVED path with PATH_ARCHIVED and leaves its order alone", async () => {
    const w = await pathWorld();
    const [a, b] = await w.makeMany(2);
    if (!a || !b) throw new Error("fixture");
    const path = await w.makePath({ status: "ARCHIVED", courses: [a, b] });

    expect(await errorCodeOf(() => reorder(w, path.id, [b.id, a.id]))).toBe("PATH_ARCHIVED");
    expect(await w.memberIds(path.id)).toEqual([a.id, b.id]);
  });

  it("another tenant's path, an unknown path and a malformed id are NOT_FOUND, and the other path is untouched", async () => {
    const w = await pathWorld();
    const other = await pathWorld();
    const [x, y] = await other.makeMany(2);
    if (!x || !y) throw new Error("fixture");
    const theirs = await other.makePath({ courses: [x, y] });

    for (const id of [theirs.id, "does-not-exist", "bad id!", undefined]) {
      expect(await errorCodeOf(() => reorder(w, id, [y.id, x.id]))).toBe("NOT_FOUND");
    }
    expect(await other.memberIds(theirs.id)).toEqual([x.id, y.id]);
  });

  it("refuses everyone who is not an ORG_ADMIN of a tenant, before reading the id or the body", async () => {
    const { w, a, b, c, d, path } = await fourCourses();

    for (const [name, ctx] of w.outsiders) {
      expect(
        await errorCodeOf(() =>
          reorderLearningPath(ctx, path.id, { courseIds: [d.id, c.id, b.id, a.id] })
        ),
        name
      ).toBe("FORBIDDEN");
      expect(await errorCodeOf(() => reorderLearningPath(ctx, "!", "junk")), name).toBe(
        "FORBIDDEN"
      );
    }
    expect(await w.memberIds(path.id)).toEqual([a.id, b.id, c.id, d.id]);
  });
});
