import { auth } from "@clerk/nextjs/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { pathWorld } from "@/lib/domain/learning-path/__test__/pathWorld";
import { jsonRequest, refusals } from "@/lib/domain/learning-path/__test__/routeAuth";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));

const { GET, POST } = await import("./route");

const signInAs = (clerkId: string | null) =>
  vi.mocked(auth).mockResolvedValue({ userId: clerkId } as never);

const post = (body: unknown, raw = false) =>
  POST(jsonRequest("http://localhost/api/org/paths", "POST", body, raw));
const get = (search = "") => GET(new Request(`http://localhost/api/org/paths${search}`));

afterEach(() => {
  vi.mocked(auth).mockReset();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("POST /api/org/paths — authorization", () => {
  it("turns away everyone who is not an ORG_ADMIN of a tenant, whatever the body, and writes nothing", async () => {
    const w = await pathWorld();
    const before = await db.learningPath.count();

    for (const [name, clerkId, status] of refusals(w)) {
      signInAs(clerkId);
      expect((await post({ title: "T" })).status, name).toBe(status);
      expect((await post("{{{", true)).status, `${name}, malformed JSON`).toBe(status);
      expect((await post({ tenantId: w.tenant.id, nonsense: 1 })).status, `${name}, forged`).toBe(
        status
      );
    }
    expect(await db.learningPath.count()).toBe(before);
  });
});

describe("POST /api/org/paths", () => {
  it("creates a DRAFT path for the admin's tenant, from the session and nothing in the body", async () => {
    const w = await pathWorld();
    signInAs(w.admin.user.clerkId);

    const res = await post({ title: " Onboarding ", description: "Week one" });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.path).toMatchObject({
      title: "Onboarding",
      description: "Week one",
      status: "DRAFT",
      publishedAt: null,
      courseCount: 0,
    });
    expect(await db.learningPath.findUniqueOrThrow({ where: { id: body.path.id } })).toMatchObject({
      tenantId: w.tenant.id,
      createdById: w.admin.user.id,
    });
    expect(JSON.stringify(body)).not.toContain(w.tenant.id);
  });

  it.each([
    ["tenantId"],
    ["createdById"],
    ["status"],
    ["publishedAt"],
    ["id"],
    ["position"],
    ["mystery"],
  ])("refuses a forged %s with 400 and creates nothing", async (key) => {
    const w = await pathWorld();
    const foreign = await pathWorld();
    signInAs(w.admin.user.clerkId);
    const before = await db.learningPath.count();

    const res = await post({
      title: "T",
      [key]: key === "tenantId" ? foreign.tenant.id : "PUBLISHED",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_INPUT" });
    expect(await db.learningPath.count()).toBe(before);
  });

  it.each([
    ["missing title", {}],
    ["blank title", { title: "  " }],
    ["a 101-character title", { title: "x".repeat(101) }],
    ["a numeric title", { title: 5 }],
    ["a 1001-character description", { title: "T", description: "x".repeat(1001) }],
    ["a numeric description", { title: "T", description: 5 }],
    ["a null body", null],
    ["an array body", []],
  ])("refuses %s with 400", async (_name, body) => {
    const w = await pathWorld();
    signInAs(w.admin.user.clerkId);

    const res = await post(body);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_INPUT" });
  });

  it("refuses a body that is not JSON, or empty, with 400", async () => {
    const w = await pathWorld();
    signInAs(w.admin.user.clerkId);

    expect((await post("{{{", true)).status).toBe(400);
    expect(
      (await POST(new Request("http://localhost/api/org/paths", { method: "POST" }))).status
    ).toBe(400);
  });

  it("answers a failure with a generic 500 and nothing internal", async () => {
    const w = await pathWorld();
    signInAs(w.admin.user.clerkId);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(db.learningPath, "create").mockRejectedValueOnce(
      new Error('relation "LearningPath" does not exist')
    );

    const res = await post({ title: "T" });
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: "Couldn't create that learning path" });
    expect(text).not.toContain("relation");
  });
});

describe("GET /api/org/paths — authorization", () => {
  it("turns away everyone who is not an ORG_ADMIN of a tenant, before reading the query", async () => {
    const w = await pathWorld();
    await w.makePath();

    for (const [name, clerkId, status] of refusals(w)) {
      signInAs(clerkId);
      expect((await get()).status, name).toBe(status);
      expect((await get("?status=junk&limit=-1&cursor=x")).status, `${name}, bad query`).toBe(
        status
      );
    }
  });
});

describe("GET /api/org/paths", () => {
  it("lists the admin's tenant's paths in every status, newest first, and no other tenant's", async () => {
    const w = await pathWorld();
    const other = await pathWorld();
    const [older, newer] = await Promise.all([
      w.makePath({ status: "PUBLISHED", createdAt: new Date("2026-01-01") }),
      w.makePath({ status: "ARCHIVED", createdAt: new Date("2026-01-02") }),
    ]);
    const theirs = await other.makePath();
    signInAs(w.admin.user.clerkId);

    const res = await get();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.paths.map((p: { id: string }) => p.id)).toEqual([newer.id, older.id]);
    expect(body).toMatchObject({ hasMore: false, nextCursor: null });
    expect(JSON.stringify(body)).not.toContain(theirs.id);
    expect(JSON.stringify(body)).not.toContain(other.tenant.id);
  });

  it("filters by status, in any case", async () => {
    const w = await pathWorld();
    await Promise.all([w.makePath({ status: "PUBLISHED" }), w.makePath({ status: "DRAFT" })]);
    signInAs(w.admin.user.clerkId);

    const body = await (await get("?status=published")).json();

    expect(body.paths).toHaveLength(1);
    expect(body.paths[0].status).toBe("PUBLISHED");
  });

  it("pages with a cursor and a limit", async () => {
    const w = await pathWorld();
    const base = Date.now() - 100_000;
    const made = [];
    for (let i = 0; i < 5; i++)
      made.push(await w.makePath({ createdAt: new Date(base + i * 1000) }));
    signInAs(w.admin.user.clerkId);

    const first = await (await get("?limit=2")).json();
    const second = await (
      await get(`?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)
    ).json();
    const third = await (
      await get(`?limit=2&cursor=${encodeURIComponent(second.nextCursor)}`)
    ).json();

    expect(first.hasMore && second.hasMore).toBe(true);
    expect(third).toMatchObject({ hasMore: false, nextCursor: null });
    expect(
      [...first.paths, ...second.paths, ...third.paths].map((p: { id: string }) => p.id)
    ).toEqual([...made].reverse().map((p) => p.id));
  });

  it("defaults to 50 a page and caps a page at 200", async () => {
    const w = await pathWorld();
    const start = Date.now() - 100_000_000;
    await db.learningPath.createMany({
      data: Array.from({ length: 201 }, (_, i) => ({
        tenantId: w.tenant.id,
        title: `Bulk ${i}`,
        createdAt: new Date(start + i * 1000),
      })),
    });
    signInAs(w.admin.user.clerkId);

    expect((await (await get()).json()).paths).toHaveLength(50);
    expect((await (await get("?limit=500")).json()).paths).toHaveLength(200);
    expect((await (await get("?limit=200")).json()).paths).toHaveLength(200);
  });

  it.each([
    ["an unknown status", "?status=ACTIVE"],
    ["a limit of 0", "?limit=0"],
    ["a negative limit", "?limit=-3"],
    ["a limit that is not a number", "?limit=lots"],
    ["a malformed cursor", "?cursor=not-a-cursor"],
    ["a cursor that decodes to the wrong thing", `?cursor=${Buffer.from("[]").toString("base64")}`],
  ])("refuses %s with 400", async (_name, search) => {
    const w = await pathWorld();
    signInAs(w.admin.user.clerkId);

    const res = await get(search);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_INPUT" });
  });

  it("answers a failure with a generic 500 and nothing internal", async () => {
    const w = await pathWorld();
    signInAs(w.admin.user.clerkId);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(db.learningPath, "findMany").mockRejectedValueOnce(
      new Error("connection refused: 10.0.0.1")
    );

    const res = await get();
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: "Failed to load learning paths" });
    expect(text).not.toContain("10.0.0.1");
  });
});
