import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { errorCodeOf, pathWorld } from "@/lib/domain/learning-path/__test__/pathWorld";
import { getLearningPathForAdmin } from "@/lib/domain/learning-path/paths";

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("getLearningPathForAdmin", () => {
  it.each(["DRAFT", "PUBLISHED", "ARCHIVED"] as const)(
    "shows a %s path to its tenant's admin",
    async (status) => {
      const w = await pathWorld();
      const course = await w.make();
      const path = await w.makePath({ status, title: "Journey", courses: [course] });

      const detail = await getLearningPathForAdmin(w.admin.ctx, path.id);

      expect(detail).toMatchObject({
        id: path.id,
        title: "Journey",
        description: null,
        status,
      });
      expect(detail.publishedAt).toEqual(status === "PUBLISHED" ? expect.any(Date) : null);
      expect(detail.createdAt).toBeInstanceOf(Date);
      expect(detail.updatedAt).toBeInstanceOf(Date);
      expect(detail.courses).toHaveLength(1);
    }
  );

  it("lists the courses by position, whatever order they were stored in", async () => {
    const w = await pathWorld();
    const [a, b, c] = await w.makeMany(3);
    if (!a || !b || !c) throw new Error("fixture");
    const path = await w.makePath();
    for (const [course, position] of [
      [c, 3],
      [a, 1],
      [b, 2],
    ] as const) {
      await db.learningPathCourse.create({
        data: { pathId: path.id, courseId: course.id, position },
      });
    }

    const detail = await getLearningPathForAdmin(w.admin.ctx, path.id);

    expect(detail.courses.map((x) => [x.courseId, x.position])).toEqual([
      [a.id, 1],
      [b.id, 2],
      [c.id, 3],
    ]);
  });

  it("breaks a tie or a gap in positions deterministically, by course id", async () => {
    const w = await pathWorld();
    const courses = await w.makeMany(3);
    const path = await w.makePath();
    for (const course of courses) {
      await db.learningPathCourse.create({
        data: { pathId: path.id, courseId: course.id, position: 7 },
      });
    }

    const detail = await getLearningPathForAdmin(w.admin.ctx, path.id);

    expect(detail.courses.map((c) => c.courseId)).toEqual(courses.map((c) => c.id).sort());
  });

  it("describes each course as it is now, and never changes the path to match", async () => {
    const w = await pathWorld();
    const live = await w.make();
    const drift = await w.make();
    const draft = await w.make({ status: "DRAFT" });
    const bare = await w.make({ lessons: false });
    const path = await w.makePath({
      status: "PUBLISHED",
      courses: [live, drift, draft, bare],
    });
    await w.archive(drift.id);

    const detail = await getLearningPathForAdmin(w.admin.ctx, path.id);

    expect(detail.courses.map((c) => [c.courseStatus, c.availability, c.blockReason])).toEqual([
      ["PUBLISHED", "AVAILABLE", null],
      ["ARCHIVED", "UNAVAILABLE", "ARCHIVED"],
      ["DRAFT", "UNAVAILABLE", "NOT_PUBLISHED"],
      ["PUBLISHED", "UNAVAILABLE", "NO_PUBLISHED_LESSON"],
    ]);
    expect(detail.status).toBe("PUBLISHED");
    expect(await w.memberIds(path.id)).toHaveLength(4);
    expect((await db.learningPath.findUniqueOrThrow({ where: { id: path.id } })).status).toBe(
      "PUBLISHED"
    );
  });

  it("gives a course only its management fields", async () => {
    const w = await pathWorld();
    const course = await w.make();
    const path = await w.makePath({ courses: [course] });

    const [entry] = (await getLearningPathForAdmin(w.admin.ctx, path.id)).courses;

    expect(entry).toEqual({
      courseId: course.id,
      slug: course.slug,
      title: course.title,
      position: 1,
      courseStatus: "PUBLISHED",
      availability: "AVAILABLE",
      blockReason: null,
    });
  });

  it("does not expose the tenant or the creator", async () => {
    const w = await pathWorld();
    const path = await w.makePath();

    const detail = await getLearningPathForAdmin(w.admin.ctx, path.id);

    expect(detail).not.toHaveProperty("tenantId");
    expect(detail).not.toHaveProperty("createdById");
  });

  it("another tenant's path, an unknown path and a malformed id are the same NOT_FOUND", async () => {
    const w = await pathWorld();
    const other = await pathWorld();
    const theirs = await other.makePath({ courses: [await other.make()] });

    for (const id of [theirs.id, "does-not-exist", "bad id!", "", 7, undefined]) {
      expect(await errorCodeOf(() => getLearningPathForAdmin(w.admin.ctx, id))).toBe("NOT_FOUND");
    }
  });

  it("refuses everyone who is not an ORG_ADMIN of a tenant, and says nothing about whether the path exists", async () => {
    const w = await pathWorld();
    const path = await w.makePath();

    for (const [name, ctx] of w.outsiders) {
      expect(await errorCodeOf(() => getLearningPathForAdmin(ctx, path.id)), name).toBe(
        "FORBIDDEN"
      );
      expect(await errorCodeOf(() => getLearningPathForAdmin(ctx, "nope")), name).toBe("FORBIDDEN");
    }
  });

  it("reads in three queries whether the path holds 1 course or 20", async () => {
    async function measure(count: number) {
      const w = await pathWorld();
      const path = await w.makePath({ courses: await w.makeMany(count) });
      const spies = [
        vi.spyOn(db.learningPath, "findFirst"),
        vi.spyOn(db.learningPathCourse, "findMany"),
        vi.spyOn(db.section, "findMany"),
      ];
      const detail = await getLearningPathForAdmin(w.admin.ctx, path.id);
      const calls = spies.map((s) => s.mock.calls.length);
      vi.restoreAllMocks();
      return { calls, count: detail.courses.length };
    }

    const one = await measure(1);
    const twenty = await measure(20);

    expect(one.count).toBe(1);
    expect(twenty.count).toBe(20);
    expect(twenty.calls).toEqual(one.calls);
    expect(twenty.calls).toEqual([1, 1, 1]);
  });

  it("writes nothing", async () => {
    const w = await pathWorld();
    const path = await w.makePath({ courses: await w.makeMany(2) });
    const before = await db.learningPath.findUniqueOrThrow({ where: { id: path.id } });
    const counts = await w.sideEffects();

    await getLearningPathForAdmin(w.admin.ctx, path.id);

    expect(await db.learningPath.findUniqueOrThrow({ where: { id: path.id } })).toEqual(before);
    expect(await w.sideEffects()).toEqual(counts);
  });
});
