import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  type LearnerWorld,
  learnerWorld,
  refusalOf,
} from "@/lib/domain/learner-path/__test__/learnerWorld";
import { listLearningPathsForLearner } from "@/lib/domain/learner-path/learnerPaths";
import { encodeCursor } from "@/lib/domain/learning-path/listing";

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

const list = (w: LearnerWorld, raw: { cursor?: unknown; limit?: unknown } = {}) =>
  listLearningPathsForLearner(w.learner.ctx, raw);

async function publishedPaths(w: LearnerWorld, count: number) {
  const start = Date.now() - 10_000_000;
  const made = [];
  for (let i = 0; i < count; i++) {
    made.push(await w.makePath({ status: "PUBLISHED", createdAt: new Date(start + i * 1000) }));
  }
  return made;
}

describe("listLearningPathsForLearner — what is listed", () => {
  it("lists the tenant's PUBLISHED paths only: no draft, no archived, no other tenant's", async () => {
    const w = await learnerWorld();
    const other = await learnerWorld();
    const [older, newer] = await Promise.all([
      w.makePath({ status: "PUBLISHED", createdAt: new Date("2026-01-01") }),
      w.makePath({ status: "PUBLISHED", createdAt: new Date("2026-01-02") }),
    ]);
    await w.makePath({ status: "DRAFT" });
    await w.makePath({ status: "ARCHIVED" });
    const theirs = await other.makePath({ status: "PUBLISHED" });

    const result = await list(w);

    expect(result.paths.map((p) => p.id)).toEqual([newer.id, older.id]);
    expect(JSON.stringify(result)).not.toContain(theirs.id);
    expect(result).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it("gives learner-safe fields, the course count and the learner's derived progress", async () => {
    const w = await learnerWorld();
    const [a, b, c, gone] = await Promise.all([
      w.make(),
      w.make(),
      w.make(),
      w.make({ status: "ARCHIVED" }),
    ]);
    await w.complete(a.id);
    const path = await w.publishedPath([a, b, c, gone], "Leadership");
    await db.learningPath.update({ where: { id: path.id }, data: { description: "About" } });

    const [item] = (await list(w)).paths;

    expect(item).toEqual({
      id: path.id,
      title: "Leadership",
      description: "About",
      status: "PUBLISHED",
      publishedAt: expect.any(Date),
      courseCount: 4,
      progress: { completed: 1, available: 2, percentage: 33 },
    });
    const text = JSON.stringify(item);
    for (const secret of [
      w.tenant.id,
      w.admin.user.id,
      "createdById",
      "tenantId",
      gone.title,
      gone.slug,
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it("shows an empty path with null progress, and progress that is 100% when everything is done", async () => {
    const w = await learnerWorld();
    const course = await w.make();
    await w.complete(course.id);
    const empty = await w.makePath({ status: "PUBLISHED", createdAt: new Date("2026-01-01") });
    const done = await w.makePath({
      status: "PUBLISHED",
      courses: [course],
      createdAt: new Date("2026-01-02"),
    });

    const byId = Object.fromEntries((await list(w)).paths.map((p) => [p.id, p.progress]));

    expect(byId[empty.id]).toEqual({ completed: 0, available: 0, percentage: null });
    expect(byId[done.id]).toEqual({ completed: 1, available: 0, percentage: 100 });
  });

  it("progress is the learner's own: another learner's completions do not show", async () => {
    const w = await learnerWorld();
    const course = await w.make();
    await w.publishedPath([course]);
    const other = await w.otherLearner();
    await w.complete(course.id, other.user.id);

    expect((await list(w)).paths[0]?.progress.completed).toBe(0);
    expect((await listLearningPathsForLearner(other.ctx)).paths[0]?.progress.completed).toBe(1);
  });

  it("a corrupted foreign membership counts in the course count but never as progress", async () => {
    const w = await learnerWorld();
    const foreign = await w.makeForeign();
    await w.complete(foreign.id);
    const good = await w.make();
    const path = await w.publishedPath([good]);
    await db.learningPathCourse.create({
      data: { pathId: path.id, courseId: foreign.id, position: 2 },
    });

    const [item] = (await list(w)).paths;

    expect(item?.courseCount).toBe(2);
    expect(item?.progress).toEqual({ completed: 0, available: 1, percentage: 0 });
    expect(JSON.stringify(item)).not.toContain(foreign.id);
  });
});

describe("listLearningPathsForLearner — paging", () => {
  it("defaults to 50 a page and caps a page at 200", async () => {
    const w = await learnerWorld();
    const start = Date.now() - 100_000_000;
    await db.learningPath.createMany({
      data: Array.from({ length: 201 }, (_, i) => ({
        tenantId: w.tenant.id,
        title: `Bulk ${i}`,
        status: "PUBLISHED" as const,
        createdAt: new Date(start + i * 1000),
      })),
    });

    expect((await list(w)).paths).toHaveLength(50);
    expect((await list(w, { limit: "500" })).paths).toHaveLength(200);
    expect((await list(w, { limit: 200 })).paths).toHaveLength(200);
    expect((await list(w)).hasMore).toBe(true);
  });

  it("walks every path once, newest first, and breaks a createdAt tie by id", async () => {
    const w = await learnerWorld();
    const made = await publishedPaths(w, 5);
    const at = new Date("2026-03-03T03:03:03.003Z");
    const tied = await Promise.all(
      Array.from({ length: 3 }, () => w.makePath({ status: "PUBLISHED", createdAt: at }))
    );
    const expected = [
      ...[...made].reverse().map((p) => p.id),
      ...tied.map((p) => p.id).sort((a, b) => (a < b ? 1 : -1)),
    ];

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await list(w, { limit: 3, cursor });
      seen.push(...page.paths.map((p) => p.id));
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen).toEqual(expected);
  });

  it("a page that holds exactly the limit has no next page: hasMore is false and there is no cursor", async () => {
    const w = await learnerWorld();
    await publishedPaths(w, 6);

    const first = await list(w, { limit: 3 });
    const second = await list(w, { limit: 3, cursor: first.nextCursor });
    const exact = await list(w, { limit: 6 });

    expect(first.hasMore).toBe(true);
    expect(second).toMatchObject({ hasMore: false, nextCursor: null });
    expect(second.paths).toHaveLength(3);
    expect(exact).toMatchObject({ hasMore: false, nextCursor: null });
    expect(exact.paths).toHaveLength(6);
  });

  it("a cursor from another tenant's path shows this learner only their own tenant's published paths", async () => {
    const w = await learnerWorld();
    const other = await learnerWorld();
    await publishedPaths(w, 3);
    const theirs = await other.makePath({ status: "PUBLISHED" });
    await w.makePath({ status: "DRAFT", createdAt: new Date(Date.now() + 5000) });

    const page = await list(w, {
      cursor: encodeCursor({ createdAt: new Date(Date.now() + 10_000), id: theirs.id }),
    });

    expect(page.paths).toHaveLength(3);
    expect(page.paths.map((p) => p.id)).not.toContain(theirs.id);
  });

  it.each([0, -1, "0", "-5", "abc", "1.5", "12345678901"])(
    "refuses the limit %j",
    async (limit) => {
      const w = await learnerWorld();

      expect(await refusalOf(() => list(w, { limit }))).toBe("INVALID_INPUT");
    }
  );

  it.each(["not-a-cursor", Buffer.from("[]").toString("base64"), 5])(
    "refuses the cursor %j",
    async (cursor) => {
      const w = await learnerWorld();

      expect(await refusalOf(() => list(w, { cursor }))).toBe("INVALID_INPUT");
    }
  );
});

describe("listLearningPathsForLearner — bounded queries", () => {
  it("reads the same fixed set of queries for 1 path as for 8, however many courses they hold", async () => {
    async function measure(paths: number) {
      const w = await learnerWorld();
      const shared = await w.make();
      const courses = await w.makeMany(4);
      for (const c of courses) await w.requires(c.id, shared.id);
      for (let i = 0; i < paths; i++) await w.publishedPath(courses);
      const spies = {
        user: vi.spyOn(db.user, "findFirst"),
        paths: vi.spyOn(db.learningPath, "findMany"),
        members: vi.spyOn(db.learningPathCourse, "findMany"),
        sections: vi.spyOn(db.section, "findMany"),
        enrollments: vi.spyOn(db.enrollment, "findMany"),
        edges: vi.spyOn(db.coursePrerequisite, "findMany"),
        courses: vi.spyOn(db.course, "findMany"),
      };
      const result = await list(w);
      const calls = Object.fromEntries(
        Object.entries(spies).map(([k, s]) => [k, s.mock.calls.length])
      );
      vi.restoreAllMocks();
      return { calls, count: result.paths.length };
    }

    const one = await measure(1);
    const eight = await measure(8);

    expect([one.count, eight.count]).toEqual([1, 8]);
    expect(eight.calls).toEqual(one.calls);
    expect(one.calls).toEqual({
      user: 1,
      paths: 1,
      members: 1,
      sections: 2,
      enrollments: 2,
      edges: 1,
      courses: 0,
    });
  });

  it("an empty page reads only the identity and the page", async () => {
    const w = await learnerWorld();
    const spies = [
      vi.spyOn(db.learningPathCourse, "findMany"),
      vi.spyOn(db.section, "findMany"),
      vi.spyOn(db.enrollment, "findMany"),
      vi.spyOn(db.coursePrerequisite, "findMany"),
    ];

    await list(w);

    expect(spies.map((s) => s.mock.calls.length)).toEqual([0, 0, 0, 0]);
  });
});
