import { auth } from "@clerk/nextjs/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { learnerWorld } from "@/lib/domain/learner-path/__test__/learnerWorld";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));

const routeModule = await import("./route");
const { GET } = routeModule;

const signInAs = (clerkId: string | null) =>
  vi.mocked(auth).mockResolvedValue({ userId: clerkId } as never);

const get = (search = "") => GET(new Request(`http://localhost/api/paths${search}`));

afterEach(() => {
  vi.mocked(auth).mockReset();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("GET /api/paths — who may ask", () => {
  it("401 without a session, and for a Clerk user with no Lumio row", async () => {
    signInAs(null);
    expect((await get()).status).toBe(401);
    signInAs("clerk_never_synced");
    expect((await get()).status).toBe(401);
  });

  it("403 for an instructor, an ORG_ADMIN and a SUPER_ADMIN, before the query is read", async () => {
    const w = await learnerWorld();
    await w.publishedPath([await w.make()]);

    for (const [name, clerkId] of [
      ["INSTRUCTOR", w.instructor.user.clerkId],
      ["ORG_ADMIN", w.admin.user.clerkId],
      ["SUPER_ADMIN", w.superAdmin.user.clerkId],
    ] as const) {
      signInAs(clerkId);
      expect((await get()).status, name).toBe(403);
      expect((await get("?limit=junk&userId=x")).status, `${name}, bad query`).toBe(403);
    }
  });

  it("400 for a student with no organisation, 403 for a tenantless ORG_ADMIN (the role is checked first), as every learner route behaves", async () => {
    const w = await learnerWorld();
    const solo = await db.user.create({
      data: {
        clerkId: `solo-${Date.now()}`,
        email: `solo-${Date.now()}@example.test`,
        role: "STUDENT",
      },
    });
    signInAs(solo.clerkId);
    expect((await get()).status).toBe(400);
    signInAs(w.tenantlessAdmin.clerkId);
    expect((await get()).status).toBe(403);
  });

  it("403 for a student whose account was deleted", async () => {
    const w = await learnerWorld();
    await db.user.update({ where: { id: w.learner.user.id }, data: { deletedAt: new Date() } });
    signInAs(w.learner.user.clerkId);

    expect((await get()).status).toBe(403);
  });

  it("exports nothing but GET: there is no way to write through this route", () => {
    expect(Object.keys(routeModule).filter((k) => /^(POST|PUT|PATCH|DELETE)$/.test(k))).toEqual([]);
  });
});

describe("GET /api/paths", () => {
  it("lists the learner's tenant's published paths with progress, and nothing else", async () => {
    const w = await learnerWorld();
    const other = await learnerWorld();
    const [a, b] = await w.makeMany(2);
    if (!a || !b) throw new Error("fixture");
    await w.complete(a.id);
    const path = await w.publishedPath([a, b], "Leadership");
    await w.makePath({ status: "DRAFT", courses: [a] });
    await w.makePath({ status: "ARCHIVED", courses: [a] });
    const theirs = await other.publishedPath([await other.make()]);
    signInAs(w.learner.user.clerkId);

    const res = await get();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      paths: [
        {
          id: path.id,
          title: "Leadership",
          description: null,
          status: "PUBLISHED",
          publishedAt: expect.any(String),
          courseCount: 2,
          progress: { completed: 1, available: 1, percentage: 50 },
        },
      ],
      hasMore: false,
      nextCursor: null,
    });
    const text = JSON.stringify(body);
    for (const secret of [
      theirs.id,
      other.tenant.id,
      w.tenant.id,
      w.admin.user.id,
      "createdById",
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it("pages with limit and cursor, and caps the limit at 200", async () => {
    const w = await learnerWorld();
    const base = Date.now() - 100_000;
    const made = [];
    for (let i = 0; i < 5; i++) {
      made.push(await w.makePath({ status: "PUBLISHED", createdAt: new Date(base + i * 1000) }));
    }
    signInAs(w.learner.user.clerkId);

    const first = await (await get("?limit=2")).json();
    const second = await (
      await get(`?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)
    ).json();
    const third = await (
      await get(`?limit=2&cursor=${encodeURIComponent(second.nextCursor)}`)
    ).json();

    expect(
      [...first.paths, ...second.paths, ...third.paths].map((p: { id: string }) => p.id)
    ).toEqual([...made].reverse().map((p) => p.id));
    expect(third).toMatchObject({ hasMore: false, nextCursor: null });
    expect((await (await get("?limit=1000")).json()).paths).toHaveLength(5);
  });

  it.each([
    ["a limit of 0", "?limit=0"],
    ["a negative limit", "?limit=-3"],
    ["a non-numeric limit", "?limit=lots"],
    ["a malformed cursor", "?cursor=not-a-cursor"],
    ["a cursor that decodes to the wrong thing", `?cursor=${Buffer.from("[]").toString("base64")}`],
    ["a user id in the URL", "?userId=someone"],
    ["a tenant id in the URL", "?tenantId=someone"],
    ["a status filter", "?status=DRAFT"],
    ["a repeated limit", "?limit=1&limit=2"],
  ])("refuses %s with 400", async (_name, search) => {
    const w = await learnerWorld();
    signInAs(w.learner.user.clerkId);

    const res = await get(search);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_INPUT" });
  });

  it("answers a failure with a generic 500 and nothing internal", async () => {
    const w = await learnerWorld();
    signInAs(w.learner.user.clerkId);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(db.learningPath, "findMany").mockRejectedValueOnce(
      new Error('relation "LearningPath" does not exist')
    );

    const res = await get();
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: "Failed to load learning paths" });
    expect(text).not.toContain("relation");
  });
});
