import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { errorCodeOf, pathWorld } from "@/lib/domain/learning-path/__test__/pathWorld";
import { encodeCursor } from "@/lib/domain/learning-path/listing";
import { listLearningPathsForAdmin } from "@/lib/domain/learning-path/paths";

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

type World = Awaited<ReturnType<typeof pathWorld>>;

/** `count` paths a second apart, oldest first, so newest-first order is the reverse. */
async function makePaths(
  w: World,
  count: number,
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED" = "DRAFT"
) {
  const start = Date.now() - 10_000_000;
  const paths = [];
  for (let i = 0; i < count; i++) {
    paths.push(await w.makePath({ status, createdAt: new Date(start + i * 1000) }));
  }
  return paths;
}

async function bulk(w: World, count: number) {
  const start = Date.now() - 100_000_000;
  await db.learningPath.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      tenantId: w.tenant.id,
      title: `Bulk ${i}`,
      createdAt: new Date(start + i * 1000),
    })),
  });
}

describe("listLearningPathsForAdmin — scope and shape", () => {
  it("lists the caller's tenant's paths in every status, newest first, and nobody else's", async () => {
    const w = await pathWorld();
    const other = await pathWorld();
    const [draft, published, archived] = await Promise.all([
      w.makePath({ status: "DRAFT", createdAt: new Date("2026-01-01") }),
      w.makePath({ status: "PUBLISHED", createdAt: new Date("2026-01-02") }),
      w.makePath({ status: "ARCHIVED", createdAt: new Date("2026-01-03") }),
    ]);
    const theirs = await other.makePath({ status: "PUBLISHED" });

    const list = await listLearningPathsForAdmin(w.admin.ctx);

    expect(list.paths.map((p) => p.id)).toEqual([archived.id, published.id, draft.id]);
    expect(list.paths.map((p) => p.id)).not.toContain(theirs.id);
    expect(list).toMatchObject({ hasMore: false, nextCursor: null });
    expect(JSON.stringify(list)).not.toContain(other.tenant.id);
  });

  it("gives each path's course count", async () => {
    const w = await pathWorld();
    const courses = await w.makeMany(3);
    const empty = await w.makePath({ createdAt: new Date("2026-01-01") });
    const one = await w.makePath({
      courses: courses.slice(0, 1),
      createdAt: new Date("2026-01-02"),
    });
    const three = await w.makePath({ courses, createdAt: new Date("2026-01-03") });

    const list = await listLearningPathsForAdmin(w.admin.ctx);

    expect(Object.fromEntries(list.paths.map((p) => [p.id, p.courseCount]))).toEqual({
      [empty.id]: 0,
      [one.id]: 1,
      [three.id]: 3,
    });
  });

  it("does not expose the tenant or the creator", async () => {
    const w = await pathWorld();
    await w.makePath();

    const [path] = (await listLearningPathsForAdmin(w.admin.ctx)).paths;

    expect(path).not.toHaveProperty("tenantId");
    expect(path).not.toHaveProperty("createdById");
  });

  it("is empty, with no cursor, for a tenant with no paths", async () => {
    const w = await pathWorld();

    expect(await listLearningPathsForAdmin(w.admin.ctx)).toEqual({
      paths: [],
      hasMore: false,
      nextCursor: null,
    });
  });

  it("refuses everyone who is not an ORG_ADMIN of a tenant, before reading the query", async () => {
    const w = await pathWorld();
    await w.makePath();

    for (const [name, ctx] of w.outsiders) {
      expect(await errorCodeOf(() => listLearningPathsForAdmin(ctx)), name).toBe("FORBIDDEN");
      expect(
        await errorCodeOf(() => listLearningPathsForAdmin(ctx, { status: "junk" })),
        name
      ).toBe("FORBIDDEN");
    }
  });
});

describe("listLearningPathsForAdmin — paging", () => {
  it("defaults to 50 a page", async () => {
    const w = await pathWorld();
    await bulk(w, 51);

    const first = await listLearningPathsForAdmin(w.admin.ctx);

    expect(first.paths).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    const second = await listLearningPathsForAdmin(w.admin.ctx, { cursor: first.nextCursor });
    expect(second.paths).toHaveLength(1);
    expect(second).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it("caps a page at 200 however many are asked for", async () => {
    const w = await pathWorld();
    await bulk(w, 201);

    for (const limit of ["500", 1000, "200"]) {
      const page = await listLearningPathsForAdmin(w.admin.ctx, { limit });
      expect(page.paths).toHaveLength(200);
      expect(page.hasMore).toBe(true);
    }
  });

  it("walks every path once, newest first, across pages", async () => {
    const w = await pathWorld();
    const made = await makePaths(w, 7);
    const newestFirst = [...made].reverse().map((p) => p.id);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await listLearningPathsForAdmin(w.admin.ctx, { limit: 3, cursor });
      seen.push(...page.paths.map((p) => p.id));
      cursor = page.nextCursor;
      pages += 1;
      expect(page.hasMore).toBe(cursor !== null);
    } while (cursor);

    expect(pages).toBe(3);
    expect(seen).toEqual(newestFirst);
  });

  it("breaks a tie on createdAt by id, so paths made in the same instant are neither lost nor repeated", async () => {
    const w = await pathWorld();
    const at = new Date("2026-03-03T03:03:03.003Z");
    const made = await Promise.all(Array.from({ length: 5 }, () => w.makePath({ createdAt: at })));
    const expected = made.map((p) => p.id).sort((a, b) => (a < b ? 1 : -1));

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await listLearningPathsForAdmin(w.admin.ctx, { limit: 2, cursor });
      seen.push(...page.paths.map((p) => p.id));
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen).toEqual(expected);
  });

  it("a cursor taken from another tenant's path shows this tenant only its own paths", async () => {
    const w = await pathWorld();
    const other = await pathWorld();
    await makePaths(w, 3);
    const theirs = await other.makePath({ createdAt: new Date() });

    const page = await listLearningPathsForAdmin(w.admin.ctx, {
      cursor: encodeCursor({ createdAt: new Date(Date.now() + 1000), id: theirs.id }),
    });

    expect(page.paths).toHaveLength(3);
    expect(page.paths.map((p) => p.id)).not.toContain(theirs.id);
  });

  it.each([0, -1, "0", "-5", "abc", "1.5", 1.5, "", "12345678901"])(
    "refuses the limit %j unless it is absent",
    async (limit) => {
      const w = await pathWorld();

      const code = await errorCodeOf(() => listLearningPathsForAdmin(w.admin.ctx, { limit }));

      expect(code).toBe(limit === "" ? null : "INVALID_INPUT");
    }
  );

  it.each([
    "not-base64-json",
    Buffer.from("[]").toString("base64"),
    Buffer.from(JSON.stringify({ createdAt: "yesterday", id: "abc" })).toString("base64"),
    Buffer.from(JSON.stringify({ createdAt: "2026-01-01T00:00:00.000Z" })).toString("base64"),
    Buffer.from(JSON.stringify({ createdAt: "2026-01-01T00:00:00.000Z", id: "a b" })).toString(
      "base64"
    ),
    Buffer.from(JSON.stringify({ createdAt: "2026-01-01", id: "abc" })).toString("base64"),
  ])("refuses the malformed cursor %s", async (cursor) => {
    const w = await pathWorld();

    expect(await errorCodeOf(() => listLearningPathsForAdmin(w.admin.ctx, { cursor }))).toBe(
      "INVALID_INPUT"
    );
  });
});

describe("listLearningPathsForAdmin — status filter", () => {
  it("applies the filter before the page is cut", async () => {
    const w = await pathWorld();
    const base = Date.now() - 1_000_000;
    // Newest first: draft, draft, draft, published, draft, published.
    const wanted: string[] = [];
    for (const [i, status] of (
      ["PUBLISHED", "DRAFT", "PUBLISHED", "DRAFT", "DRAFT", "DRAFT"] as const
    ).entries()) {
      const path = await w.makePath({ status, createdAt: new Date(base + i * 1000) });
      if (status === "PUBLISHED") wanted.unshift(path.id);
    }

    const first = await listLearningPathsForAdmin(w.admin.ctx, { status: "PUBLISHED", limit: 1 });
    const second = await listLearningPathsForAdmin(w.admin.ctx, {
      status: "PUBLISHED",
      limit: 1,
      cursor: first.nextCursor,
    });

    expect([...first.paths, ...second.paths].map((p) => p.id)).toEqual(wanted);
    expect(first.hasMore).toBe(true);
    expect(second).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it.each(["DRAFT", "PUBLISHED", "ARCHIVED"] as const)("filters to %s only", async (status) => {
    const w = await pathWorld();
    await Promise.all(
      (["DRAFT", "PUBLISHED", "ARCHIVED"] as const).map((s) => w.makePath({ status: s }))
    );

    const list = await listLearningPathsForAdmin(w.admin.ctx, { status });

    expect(list.paths).toHaveLength(1);
    expect(list.paths[0]?.status).toBe(status);
  });

  it("accepts the status in any case, and an absent or empty one means every status", async () => {
    const w = await pathWorld();
    await Promise.all([w.makePath({ status: "PUBLISHED" }), w.makePath({ status: "DRAFT" })]);

    expect(
      (await listLearningPathsForAdmin(w.admin.ctx, { status: " published " })).paths
    ).toHaveLength(1);
    expect((await listLearningPathsForAdmin(w.admin.ctx, { status: "" })).paths).toHaveLength(2);
    expect((await listLearningPathsForAdmin(w.admin.ctx, { status: null })).paths).toHaveLength(2);
  });

  it.each(["ALL", "ACTIVE", "publish", 5, {}])("refuses the status %j", async (status) => {
    const w = await pathWorld();

    expect(await errorCodeOf(() => listLearningPathsForAdmin(w.admin.ctx, { status }))).toBe(
      "INVALID_INPUT"
    );
  });
});

describe("listLearningPathsForAdmin — bounded queries", () => {
  it("reads the page in one query and never loads courses or lessons, whether it holds 1 path or 8", async () => {
    async function measure(paths: number) {
      const w = await pathWorld();
      const courses = await w.makeMany(3);
      for (let i = 0; i < paths; i++) await w.makePath({ courses });
      const spies = [
        vi.spyOn(db.learningPath, "findMany"),
        vi.spyOn(db.learningPathCourse, "findMany"),
        vi.spyOn(db.section, "findMany"),
        vi.spyOn(db.course, "findMany"),
      ];
      const list = await listLearningPathsForAdmin(w.admin.ctx);
      const calls = spies.map((s) => s.mock.calls.length);
      vi.restoreAllMocks();
      return { calls, list };
    }

    const one = await measure(1);
    const eight = await measure(8);

    expect(one.list.paths).toHaveLength(1);
    expect(eight.list.paths).toHaveLength(8);
    expect(eight.list.paths.every((p) => p.courseCount === 3)).toBe(true);
    expect(one.calls).toEqual([1, 0, 0, 0]);
    expect(eight.calls).toEqual(one.calls);
  });
});
