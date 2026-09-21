import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { errorCodeOf, pathWorld } from "@/lib/domain/learning-path/__test__/pathWorld";
import {
  addCourseToLearningPath,
  archiveLearningPath,
  getLearningPathForAdmin,
  listLearningPathsForAdmin,
  reorderLearningPath,
  updateLearningPath,
} from "@/lib/domain/learning-path/paths";

afterAll(async () => {
  await db.$disconnect();
});

const row = (id: string) => db.learningPath.findUniqueOrThrow({ where: { id } });

describe("archiveLearningPath", () => {
  it("archives a DRAFT that holds courses", async () => {
    const w = await pathWorld();
    const courses = await w.makeMany(2);
    const path = await w.makePath({ courses });

    const detail = await archiveLearningPath(w.admin.ctx, path.id);

    expect(detail.status).toBe("ARCHIVED");
    expect(detail.courses).toHaveLength(2);
    expect((await row(path.id)).status).toBe("ARCHIVED");
  });

  it("archives an empty DRAFT, which could never be published", async () => {
    const w = await pathWorld();
    const path = await w.makePath();

    expect((await archiveLearningPath(w.admin.ctx, path.id)).status).toBe("ARCHIVED");
  });

  it("archives a DRAFT that is not publishable: no publishability check is made", async () => {
    const w = await pathWorld();
    const path = await w.makePath({
      courses: [await w.make({ status: "DRAFT" }), await w.make({ status: "ARCHIVED" })],
    });

    expect((await archiveLearningPath(w.admin.ctx, path.id)).status).toBe("ARCHIVED");
  });

  it("archives a PUBLISHED path, even one whose courses have drifted", async () => {
    const w = await pathWorld();
    const course = await w.make();
    const path = await w.makePath({ status: "PUBLISHED", courses: [course] });
    await w.archive(course.id);

    expect((await archiveLearningPath(w.admin.ctx, path.id)).status).toBe("ARCHIVED");
  });

  it("keeps everything but the status and updatedAt: publishedAt, courses, order, text, creator, createdAt", async () => {
    const w = await pathWorld();
    const courses = await w.makeMany(3);
    const path = await w.makePath({ status: "PUBLISHED", title: "Keep", courses });
    await db.learningPath.update({ where: { id: path.id }, data: { description: "Keep too" } });
    const before = await row(path.id);
    const membersBefore = await db.learningPathCourse.findMany({
      where: { pathId: path.id },
      orderBy: { position: "asc" },
    });
    await new Promise((r) => setTimeout(r, 15));

    await archiveLearningPath(w.admin.ctx, path.id);

    const { status, updatedAt, ...rest } = await row(path.id);
    const { status: s0, updatedAt: u0, ...restBefore } = before;
    expect(rest).toEqual(restBefore);
    expect(rest.publishedAt).not.toBeNull();
    expect(status).toBe("ARCHIVED");
    expect(s0).toBe("PUBLISHED");
    expect(updatedAt.getTime()).toBeGreaterThan(u0.getTime());
    expect(
      await db.learningPathCourse.findMany({
        where: { pathId: path.id },
        orderBy: { position: "asc" },
      })
    ).toEqual(membersBefore);
    expect(await db.course.count({ where: { id: { in: courses.map((c) => c.id) } } })).toBe(3);
  });

  it("refuses an ARCHIVED path with INVALID_TRANSITION and changes nothing, updatedAt included", async () => {
    const w = await pathWorld();
    const path = await w.makePath({ status: "ARCHIVED" });
    const before = await row(path.id);

    expect(await errorCodeOf(() => archiveLearningPath(w.admin.ctx, path.id))).toBe(
      "INVALID_TRANSITION"
    );
    expect(await row(path.id)).toEqual(before);
  });

  it("leaves an archived path readable and listed for its admin, and read-only for everything but republishing", async () => {
    const w = await pathWorld();
    const [a, b] = await w.makeMany(2);
    const extra = await w.make();
    if (!a || !b) throw new Error("fixture");
    const path = await w.makePath({ status: "PUBLISHED", courses: [a, b] });

    await archiveLearningPath(w.admin.ctx, path.id);

    expect((await getLearningPathForAdmin(w.admin.ctx, path.id)).status).toBe("ARCHIVED");
    expect(
      (await listLearningPathsForAdmin(w.admin.ctx, { status: "ARCHIVED" })).paths.map((p) => p.id)
    ).toContain(path.id);
    expect(await errorCodeOf(() => updateLearningPath(w.admin.ctx, path.id, { title: "X" }))).toBe(
      "PATH_ARCHIVED"
    );
    expect(
      await errorCodeOf(() => addCourseToLearningPath(w.admin.ctx, path.id, { courseId: extra.id }))
    ).toBe("PATH_ARCHIVED");
    expect(
      await errorCodeOf(() =>
        reorderLearningPath(w.admin.ctx, path.id, { courseIds: [b.id, a.id] })
      )
    ).toBe("PATH_ARCHIVED");
  });

  it("another tenant's path, an unknown path and a malformed id are the same NOT_FOUND, and the other path is untouched", async () => {
    const w = await pathWorld();
    const other = await pathWorld();
    const theirs = await other.makePath({ status: "PUBLISHED", courses: [await other.make()] });

    for (const id of [theirs.id, "does-not-exist", "bad id!", 5, null]) {
      expect(await errorCodeOf(() => archiveLearningPath(w.admin.ctx, id))).toBe("NOT_FOUND");
    }
    expect((await row(theirs.id)).status).toBe("PUBLISHED");
  });

  it("refuses everyone who is not an ORG_ADMIN of a tenant, before reading the id", async () => {
    const w = await pathWorld();
    const path = await w.makePath({ status: "PUBLISHED", courses: [await w.make()] });

    for (const [name, ctx] of w.outsiders) {
      expect(await errorCodeOf(() => archiveLearningPath(ctx, path.id)), name).toBe("FORBIDDEN");
      expect(await errorCodeOf(() => archiveLearningPath(ctx, "!!")), name).toBe("FORBIDDEN");
    }
    expect((await row(path.id)).status).toBe("PUBLISHED");
  });
});
