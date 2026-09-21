import { auth } from "@clerk/nextjs/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { pathWorld } from "@/lib/domain/learning-path/__test__/pathWorld";
import { jsonRequest, refusals } from "@/lib/domain/learning-path/__test__/routeAuth";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));

const { GET, PATCH } = await import("./route");

const signInAs = (clerkId: string | null) =>
  vi.mocked(auth).mockResolvedValue({ userId: clerkId } as never);

const ctx = (id: string) => ({ params: Promise.resolve({ pathId: id }) });
const get = (id: string) => GET(new Request(`http://localhost/api/org/paths/${id}`), ctx(id));
const patch = (id: string, body: unknown, raw = false) =>
  PATCH(jsonRequest(`http://localhost/api/org/paths/${id}`, "PATCH", body, raw), ctx(id));

afterEach(() => {
  vi.mocked(auth).mockReset();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("GET /api/org/paths/[pathId]", () => {
  it("turns away everyone who is not an ORG_ADMIN of a tenant, whatever the id", async () => {
    const w = await pathWorld();
    const path = await w.makePath();

    for (const [name, clerkId, status] of refusals(w)) {
      signInAs(clerkId);
      expect((await get(path.id)).status, name).toBe(status);
      expect((await get("does-not-exist")).status, `${name}, unknown id`).toBe(status);
    }
  });

  it.each(["DRAFT", "PUBLISHED", "ARCHIVED"] as const)(
    "shows a %s path with its courses in order",
    async (status) => {
      const w = await pathWorld();
      const [a, b] = await w.makeMany(2);
      if (!a || !b) throw new Error("fixture");
      const path = await w.makePath({ status, title: "Journey", courses: [a, b] });
      signInAs(w.admin.user.clerkId);

      const res = await get(path.id);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.path).toMatchObject({ id: path.id, title: "Journey", status });
      expect(body.path.courses.map((c: { courseId: string }) => c.courseId)).toEqual([a.id, b.id]);
      expect(body.path.courses[0]).toEqual({
        courseId: a.id,
        slug: a.slug,
        title: a.title,
        position: 1,
        courseStatus: "PUBLISHED",
        availability: "AVAILABLE",
        blockReason: null,
      });
      expect(JSON.stringify(body)).not.toContain(w.tenant.id);
    }
  );

  it("reports a course archived since it was added as unavailable, and leaves the path alone", async () => {
    const w = await pathWorld();
    const course = await w.make();
    const path = await w.makePath({ status: "PUBLISHED", courses: [course] });
    await w.archive(course.id);
    signInAs(w.admin.user.clerkId);

    const body = await (await get(path.id)).json();

    expect(body.path.status).toBe("PUBLISHED");
    expect(body.path.courses[0]).toMatchObject({
      courseStatus: "ARCHIVED",
      availability: "UNAVAILABLE",
      blockReason: "ARCHIVED",
    });
  });

  it("another tenant's path, an unknown path and a malformed id are the same 404", async () => {
    const w = await pathWorld();
    const other = await pathWorld();
    const theirs = await other.makePath();
    signInAs(w.admin.user.clerkId);

    const answers = await Promise.all(
      [theirs.id, "does-not-exist", "bad id!"].map(async (id) => {
        const res = await get(id);
        return [res.status, await res.json()];
      })
    );

    expect(answers[0]).toEqual([404, { error: "Learning path not found", code: "NOT_FOUND" }]);
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
  });

  it("answers a failure with a generic 500 and nothing internal", async () => {
    const w = await pathWorld();
    const path = await w.makePath();
    signInAs(w.admin.user.clerkId);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(db.learningPath, "findFirst").mockRejectedValueOnce(
      new Error("deadlock on LearningPath")
    );

    const res = await get(path.id);
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: "Failed to load that learning path" });
    expect(text).not.toContain("deadlock");
  });
});

describe("PATCH /api/org/paths/[pathId]", () => {
  it("turns away everyone who is not an ORG_ADMIN of a tenant, whatever the body, and changes nothing", async () => {
    const w = await pathWorld();
    const path = await w.makePath({ title: "Same" });

    for (const [name, clerkId, status] of refusals(w)) {
      signInAs(clerkId);
      expect((await patch(path.id, { title: "Changed" })).status, name).toBe(status);
      expect((await patch(path.id, "{{{", true)).status, `${name}, malformed`).toBe(status);
    }
    expect((await db.learningPath.findUniqueOrThrow({ where: { id: path.id } })).title).toBe(
      "Same"
    );
  });

  it("edits the title and description of a DRAFT and of a PUBLISHED path", async () => {
    const w = await pathWorld();
    const draft = await w.makePath({ title: "Old" });
    const live = await w.makePath({ status: "PUBLISHED", courses: [await w.make()] });
    signInAs(w.admin.user.clerkId);

    const a = await patch(draft.id, { title: " New ", description: "About" });
    const b = await patch(live.id, { description: "Live text" });

    expect(a.status).toBe(200);
    expect((await a.json()).path).toMatchObject({
      title: "New",
      description: "About",
      status: "DRAFT",
    });
    expect(b.status).toBe(200);
    expect((await b.json()).path).toMatchObject({ description: "Live text", status: "PUBLISHED" });
  });

  it("refuses an ARCHIVED path with 409 PATH_ARCHIVED and does not reactivate it", async () => {
    const w = await pathWorld();
    const path = await w.makePath({ status: "ARCHIVED", title: "Frozen" });
    signInAs(w.admin.user.clerkId);

    const res = await patch(path.id, { title: "X" });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "PATH_ARCHIVED" });
    expect(await db.learningPath.findUniqueOrThrow({ where: { id: path.id } })).toMatchObject({
      status: "ARCHIVED",
      title: "Frozen",
    });
  });

  it("another tenant's path and an unknown one are the same 404, and the other path is untouched", async () => {
    const w = await pathWorld();
    const other = await pathWorld();
    const theirs = await other.makePath({ title: "Theirs" });
    signInAs(w.admin.user.clerkId);

    const foreign = await patch(theirs.id, { title: "Mine now" });
    const unknown = await patch("does-not-exist", { title: "X" });

    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual(await unknown.json());
    expect((await db.learningPath.findUniqueOrThrow({ where: { id: theirs.id } })).title).toBe(
      "Theirs"
    );
  });

  it.each([
    ["tenantId"],
    ["createdById"],
    ["status"],
    ["publishedAt"],
    ["id"],
    ["courses"],
    ["position"],
    ["mystery"],
  ])("refuses a forged %s with 400 and changes nothing", async (key) => {
    const w = await pathWorld();
    const path = await w.makePath({ title: "Same" });
    signInAs(w.admin.user.clerkId);

    const res = await patch(path.id, { title: "Changed", [key]: "PUBLISHED" });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_INPUT" });
    expect(await db.learningPath.findUniqueOrThrow({ where: { id: path.id } })).toMatchObject({
      title: "Same",
      status: "DRAFT",
    });
  });

  it.each([
    ["an empty body", {}],
    ["a blank title", { title: "  " }],
    ["a 101-character title", { title: "x".repeat(101) }],
    ["a 1001-character description", { description: "x".repeat(1001) }],
    ["a null body", null],
  ])("refuses %s with 400", async (_name, body) => {
    const w = await pathWorld();
    const path = await w.makePath();
    signInAs(w.admin.user.clerkId);

    expect((await patch(path.id, body)).status).toBe(400);
  });

  it("refuses a body that is not JSON with 400", async () => {
    const w = await pathWorld();
    const path = await w.makePath();
    signInAs(w.admin.user.clerkId);

    expect((await patch(path.id, "{{{", true)).status).toBe(400);
  });
});
