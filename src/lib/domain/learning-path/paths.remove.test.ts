import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { errorCodeOf, pathWorld } from "@/lib/domain/learning-path/__test__/pathWorld";
import { removeCourseFromLearningPath } from "@/lib/domain/learning-path/paths";
import { PathNotPublishableError } from "@/lib/domain/learning-path/types";

afterAll(async () => {
  await db.$disconnect();
});

const remove = (
  w: { admin: { ctx: Parameters<typeof removeCourseFromLearningPath>[0] } },
  pathId: unknown,
  courseId: unknown
) => removeCourseFromLearningPath(w.admin.ctx, pathId, courseId);

describe("removeCourseFromLearningPath — a DRAFT path", () => {
  it("removes the last course too, leaving an empty path", async () => {
    const w = await pathWorld();
    const course = await w.make();
    const path = await w.makePath({ courses: [course] });

    const detail = await remove(w, path.id, course.id);

    expect(detail.courses).toEqual([]);
    expect(await w.members(path.id)).toEqual([]);
    expect(await db.course.count({ where: { id: course.id } })).toBe(1);
  });

  it("closes the gap: what is left is exactly 1..n in the order it was", async () => {
    const w = await pathWorld();
    const [a, b, c, d] = await w.makeMany(4);
    if (!a || !b || !c || !d) throw new Error("fixture");
    const path = await w.makePath({ courses: [a, b, c, d] });

    const detail = await remove(w, path.id, b.id);

    expect(detail.courses.map((x) => [x.courseId, x.position])).toEqual([
      [a.id, 1],
      [c.id, 2],
      [d.id, 3],
    ]);
    expect(await w.members(path.id)).toEqual([
      { courseId: a.id, position: 1 },
      { courseId: c.id, position: 2 },
      { courseId: d.id, position: 3 },
    ]);
  });

  it("removes the first and the last as well as a middle one", async () => {
    const w = await pathWorld();
    const [a, b, c] = await w.makeMany(3);
    if (!a || !b || !c) throw new Error("fixture");
    const path = await w.makePath({ courses: [a, b, c] });

    await remove(w, path.id, a.id);
    expect(await w.members(path.id)).toEqual([
      { courseId: b.id, position: 1 },
      { courseId: c.id, position: 2 },
    ]);
    await remove(w, path.id, c.id);
    expect(await w.members(path.id)).toEqual([{ courseId: b.id, position: 1 }]);
  });

  it("renumbers gaps and ties left by earlier data into a clean 1..n", async () => {
    const w = await pathWorld();
    const [a, b, c, d] = await w.makeMany(4);
    if (!a || !b || !c || !d) throw new Error("fixture");
    const path = await w.makePath();
    await db.learningPathCourse.createMany({
      data: [
        { pathId: path.id, courseId: a.id, position: 3 },
        { pathId: path.id, courseId: b.id, position: 3 },
        { pathId: path.id, courseId: c.id, position: 9 },
        { pathId: path.id, courseId: d.id, position: 1 },
      ],
    });
    const tied = [a.id, b.id].sort();

    await remove(w, path.id, d.id);

    expect(await w.members(path.id)).toEqual([
      { courseId: tied[0], position: 1 },
      { courseId: tied[1], position: 2 },
      { courseId: c.id, position: 3 },
    ]);
  });

  it("leaves other paths that hold the same course alone", async () => {
    const w = await pathWorld();
    const [a, b] = await w.makeMany(2);
    if (!a || !b) throw new Error("fixture");
    const one = await w.makePath({ courses: [a, b] });
    const two = await w.makePath({ courses: [a, b] });

    await remove(w, one.id, a.id);

    expect(await w.members(two.id)).toEqual([
      { courseId: a.id, position: 1 },
      { courseId: b.id, position: 2 },
    ]);
  });

  it("moves the path's updatedAt", async () => {
    const w = await pathWorld();
    const course = await w.make();
    const path = await w.makePath({ courses: [course] });
    const before = (await db.learningPath.findUniqueOrThrow({ where: { id: path.id } })).updatedAt;
    await new Promise((r) => setTimeout(r, 15));

    const detail = await remove(w, path.id, course.id);

    expect(detail.updatedAt.getTime()).toBeGreaterThan(before.getTime());
  });
});

describe("removeCourseFromLearningPath — a PUBLISHED path", () => {
  it("refuses to remove the last course with LAST_COURSE", async () => {
    const w = await pathWorld();
    const course = await w.make();
    const path = await w.makePath({ status: "PUBLISHED", courses: [course] });

    expect(await errorCodeOf(() => remove(w, path.id, course.id))).toBe("LAST_COURSE");
    expect(await w.memberIds(path.id)).toEqual([course.id]);
  });

  it("removes a course while others remain, renumbering", async () => {
    const w = await pathWorld();
    const [a, b, c] = await w.makeMany(3);
    if (!a || !b || !c) throw new Error("fixture");
    const path = await w.makePath({ status: "PUBLISHED", courses: [a, b, c] });

    const detail = await remove(w, path.id, a.id);

    expect(detail.courses.map((x) => [x.courseId, x.position])).toEqual([
      [b.id, 1],
      [c.id, 2],
    ]);
    expect(detail.status).toBe("PUBLISHED");
  });

  it("removing the last course is LAST_COURSE even when that course is itself broken", async () => {
    const w = await pathWorld();
    const course = await w.make();
    const path = await w.makePath({ status: "PUBLISHED", courses: [course] });
    await w.archive(course.id);

    expect(await errorCodeOf(() => remove(w, path.id, course.id))).toBe("LAST_COURSE");
  });

  it("lets an admin repair a drifted path: a course that is itself the blocker can always be removed", async () => {
    const w = await pathWorld();
    const [good, brokenA, brokenB] = await w.makeMany(3);
    if (!good || !brokenA || !brokenB) throw new Error("fixture");
    const path = await w.makePath({ status: "PUBLISHED", courses: [good, brokenA, brokenB] });
    await w.archive(brokenA.id);
    await w.archive(brokenB.id);

    await remove(w, path.id, brokenA.id);
    expect(await w.memberIds(path.id)).toEqual([good.id, brokenB.id]);
    const detail = await remove(w, path.id, brokenB.id);

    expect(detail.courses.map((c) => [c.courseId, c.position])).toEqual([[good.id, 1]]);
    expect(detail.courses[0]?.blockReason).toBeNull();
  });

  it("refuses to remove a healthy course while a broken one would remain, naming the blocker", async () => {
    const w = await pathWorld();
    const [good, spare, broken] = await w.makeMany(3);
    if (!good || !spare || !broken) throw new Error("fixture");
    const path = await w.makePath({ status: "PUBLISHED", courses: [good, spare, broken] });
    await w.archive(broken.id);

    let caught: unknown;
    try {
      await remove(w, path.id, good.id);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PathNotPublishableError);
    expect((caught as PathNotPublishableError).problems).toEqual([
      { kind: "COURSE", courseId: broken.id, title: broken.title, reason: "ARCHIVED" },
    ]);
    expect(await w.memberIds(path.id)).toEqual([good.id, spare.id, broken.id]);
  });
});

describe("removeCourseFromLearningPath — the path and the course", () => {
  it("refuses an ARCHIVED path with PATH_ARCHIVED", async () => {
    const w = await pathWorld();
    const course = await w.make();
    const path = await w.makePath({ status: "ARCHIVED", courses: [course] });

    expect(await errorCodeOf(() => remove(w, path.id, course.id))).toBe("PATH_ARCHIVED");
    expect(await w.memberIds(path.id)).toEqual([course.id]);
  });

  it("another tenant's path, an unknown path and a malformed id are NOT_FOUND, and the other path is untouched", async () => {
    const w = await pathWorld();
    const other = await pathWorld();
    const theirCourse = await other.make();
    const theirs = await other.makePath({ courses: [theirCourse] });

    for (const id of [theirs.id, "does-not-exist", "bad id!", undefined]) {
      expect(await errorCodeOf(() => remove(w, id, theirCourse.id))).toBe("NOT_FOUND");
    }
    expect(await other.memberIds(theirs.id)).toEqual([theirCourse.id]);
  });

  it("a course that is not in the path is COURSE_NOT_FOUND, whether it is the tenant's, another tenant's, unknown or malformed", async () => {
    const w = await pathWorld();
    const member = await w.make();
    const path = await w.makePath({ courses: [member] });
    const outside = await w.make();
    const foreign = await w.makeForeign();

    for (const id of [outside.id, foreign.id, "does-not-exist", "bad id!", 5, null]) {
      expect(await errorCodeOf(() => remove(w, path.id, id))).toBe("COURSE_NOT_FOUND");
    }
    expect(await w.memberIds(path.id)).toEqual([member.id]);
  });

  it("refuses everyone who is not an ORG_ADMIN of a tenant, before reading the ids", async () => {
    const w = await pathWorld();
    const course = await w.make();
    const path = await w.makePath({ courses: [course] });

    for (const [name, ctx] of w.outsiders) {
      expect(
        await errorCodeOf(() => removeCourseFromLearningPath(ctx, path.id, course.id)),
        name
      ).toBe("FORBIDDEN");
      expect(await errorCodeOf(() => removeCourseFromLearningPath(ctx, "!", "!")), name).toBe(
        "FORBIDDEN"
      );
    }
    expect(await w.memberIds(path.id)).toEqual([course.id]);
  });
});
