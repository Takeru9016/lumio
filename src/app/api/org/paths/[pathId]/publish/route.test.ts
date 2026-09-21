import { auth } from "@clerk/nextjs/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { pathWorld } from "@/lib/domain/learning-path/__test__/pathWorld";
import { refusals } from "@/lib/domain/learning-path/__test__/routeAuth";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));

const { POST } = await import("./route");

const signInAs = (clerkId: string | null) =>
  vi.mocked(auth).mockResolvedValue({ userId: clerkId } as never);

const publish = (pathId: string, body?: string) =>
  POST(
    new Request(`http://localhost/api/org/paths/${pathId}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body }),
    }),
    { params: Promise.resolve({ pathId }) }
  );

const row = (id: string) => db.learningPath.findUniqueOrThrow({ where: { id } });

afterEach(() => {
  vi.mocked(auth).mockReset();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("POST /api/org/paths/[pathId]/publish — authorization", () => {
  it("turns away everyone who is not an ORG_ADMIN of a tenant, whatever the body or the id, and publishes nothing", async () => {
    const w = await pathWorld();
    const path = await w.makePath({ courses: [await w.make()] });

    for (const [name, clerkId, status] of refusals(w)) {
      signInAs(clerkId);
      expect((await publish(path.id, "{}")).status, name).toBe(status);
      expect((await publish(path.id)).status, `${name}, no body`).toBe(status);
      expect((await publish("does-not-exist", "{{{")).status, `${name}, junk`).toBe(status);
    }
    expect(await row(path.id)).toMatchObject({ status: "DRAFT", publishedAt: null });
  });
});

describe("POST /api/org/paths/[pathId]/publish", () => {
  it("publishes a valid DRAFT and returns the path, with an empty body, {} or whitespace", async () => {
    const w = await pathWorld();
    signInAs(w.admin.user.clerkId);

    for (const body of [undefined, "", "{}", "  "]) {
      const [a, b] = await w.makeMany(2);
      if (!a || !b) throw new Error("fixture");
      const path = await w.makePath({ courses: [a, b] });

      const res = await publish(path.id, body);
      const json = await res.json();

      expect(res.status, String(body)).toBe(200);
      expect(json.path).toMatchObject({ id: path.id, status: "PUBLISHED" });
      expect(json.path.courses.map((c: { courseId: string }) => c.courseId)).toEqual([a.id, b.id]);
      expect(new Date(json.path.publishedAt).getTime()).toBeGreaterThan(Date.now() - 5000);
      expect(JSON.stringify(json)).not.toContain(w.tenant.id);
    }
  });

  it.each([
    ["a status", '{"status":"PUBLISHED"}'],
    ["a publishedAt", '{"publishedAt":"2001-01-01T00:00:00.000Z"}'],
    ["a tenantId", '{"tenantId":"t"}'],
    ["a createdById", '{"createdById":"u"}'],
    ["a list", "[]"],
    ["null", "null"],
    ["a string", '"x"'],
    ["malformed JSON", "{{{"],
  ])("refuses a body with %s with 400, and publishes nothing", async (_name, body) => {
    const w = await pathWorld();
    const path = await w.makePath({ courses: [await w.make()] });
    signInAs(w.admin.user.clerkId);

    const res = await publish(path.id, body);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_INPUT" });
    expect(await row(path.id)).toMatchObject({ status: "DRAFT", publishedAt: null });
  });

  it("an empty path is 409 PATH_NOT_PUBLISHABLE and stays a DRAFT", async () => {
    const w = await pathWorld();
    const path = await w.makePath();
    signInAs(w.admin.user.clerkId);

    const res = await publish(path.id, "{}");

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "The path can't be published yet",
      code: "PATH_NOT_PUBLISHABLE",
      problems: [{ kind: "NO_COURSES" }],
    });
    expect((await row(path.id)).status).toBe("DRAFT");
  });

  it("names the blocking courses with 409 PATH_NOT_PUBLISHABLE", async () => {
    const w = await pathWorld();
    const [good, draft, archived, bare] = await Promise.all([
      w.make(),
      w.make({ status: "DRAFT" }),
      w.make({ status: "ARCHIVED" }),
      w.make({ lessons: false }),
    ]);
    const path = await w.makePath({ courses: [good, draft, archived, bare] });
    signInAs(w.admin.user.clerkId);

    const res = await publish(path.id, "{}");

    expect(res.status).toBe(409);
    expect((await res.json()).problems).toEqual([
      { kind: "COURSE", courseId: draft.id, title: draft.title, reason: "NOT_PUBLISHED" },
      { kind: "COURSE", courseId: archived.id, title: archived.title, reason: "ARCHIVED" },
      { kind: "COURSE", courseId: bare.id, title: bare.title, reason: "NO_PUBLISHED_LESSON" },
    ]);
    expect((await row(path.id)).status).toBe("DRAFT");
  });

  it("a foreign course forced into the path blocks it and its title never leaves the server", async () => {
    const w = await pathWorld();
    const foreign = await w.makeForeign();
    const path = await w.makePath({ courses: [await w.make()] });
    await db.learningPathCourse.create({
      data: { pathId: path.id, courseId: foreign.id, position: 2 },
    });
    signInAs(w.admin.user.clerkId);

    const res = await publish(path.id, "{}");
    const text = await res.text();

    expect(res.status).toBe(409);
    expect(JSON.parse(text).problems).toEqual([
      { kind: "COURSE", courseId: foreign.id, reason: "WRONG_TENANT" },
    ]);
    expect(text).not.toContain(foreign.title);
    expect(text).not.toContain(foreign.slug);
    expect((await row(path.id)).status).toBe("DRAFT");
  });

  it("an already PUBLISHED path is 409 INVALID_TRANSITION and is not touched", async () => {
    const w = await pathWorld();
    const path = await w.makePath({ status: "PUBLISHED", courses: [await w.make()] });
    const before = await row(path.id);
    signInAs(w.admin.user.clerkId);

    const res = await publish(path.id, "{}");

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "INVALID_TRANSITION" });
    expect(await row(path.id)).toEqual(before);
  });

  it("republishes an ARCHIVED path that is publishable now, and refuses one that is not", async () => {
    const w = await pathWorld();
    const good = await w.make();
    const broken = await w.make();
    const fine = await w.makePath({ status: "ARCHIVED", courses: [good] });
    const stale = await w.makePath({ status: "ARCHIVED", courses: [broken] });
    await w.archive(broken.id);
    signInAs(w.admin.user.clerkId);

    const ok = await publish(fine.id, "{}");
    const refused = await publish(stale.id, "{}");

    expect(ok.status).toBe(200);
    expect((await ok.json()).path.status).toBe("PUBLISHED");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "PATH_NOT_PUBLISHABLE" });
    expect((await row(stale.id)).status).toBe("ARCHIVED");
  });

  it("another tenant's path, an unknown path and a malformed id are the same 404, and the other path is untouched", async () => {
    const w = await pathWorld();
    const other = await pathWorld();
    const theirs = await other.makePath({ courses: [await other.make()] });
    signInAs(w.admin.user.clerkId);

    const answers = await Promise.all(
      [theirs.id, "does-not-exist", "bad id!"].map(async (id) => {
        const res = await publish(id, "{}");
        return [res.status, await res.json()];
      })
    );

    expect(answers[0]).toEqual([404, { error: "Learning path not found", code: "NOT_FOUND" }]);
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
    expect((await row(theirs.id)).status).toBe("DRAFT");
  });

  it("8 simultaneous publishes: one 200, seven 409 INVALID_TRANSITION, no 500", async () => {
    const w = await pathWorld();
    const path = await w.makePath({ courses: [await w.make()] });
    signInAs(w.admin.user.clerkId);

    const responses = await Promise.all(Array.from({ length: 8 }, () => publish(path.id, "{}")));
    const bodies = await Promise.all(responses.map((r) => r.json()));

    expect(responses.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409, 409, 409, 409]);
    expect(bodies.filter((b) => b.code).every((b) => b.code === "INVALID_TRANSITION")).toBe(true);
  });

  it("answers a failure with a generic 500 and nothing internal", async () => {
    const w = await pathWorld();
    const path = await w.makePath({ courses: [await w.make()] });
    signInAs(w.admin.user.clerkId);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(db, "$transaction").mockRejectedValueOnce(new Error("could not serialize access"));

    const res = await publish(path.id, "{}");
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: "Couldn't publish that learning path" });
    expect(text).not.toContain("serialize");
  });
});
