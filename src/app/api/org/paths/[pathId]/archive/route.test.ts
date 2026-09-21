import { auth } from "@clerk/nextjs/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { pathWorld } from "@/lib/domain/learning-path/__test__/pathWorld";
import { refusals } from "@/lib/domain/learning-path/__test__/routeAuth";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));

const archiveRoute = await import("./route");
const publishRoute = await import("../publish/route");

const signInAs = (clerkId: string | null) =>
  vi.mocked(auth).mockResolvedValue({ userId: clerkId } as never);

const call = (
  handler: typeof archiveRoute.POST,
  action: "archive" | "publish",
  pathId: string,
  body?: string
) =>
  handler(
    new Request(`http://localhost/api/org/paths/${pathId}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body }),
    }),
    { params: Promise.resolve({ pathId }) }
  );
const archive = (pathId: string, body?: string) => call(archiveRoute.POST, "archive", pathId, body);
const publish = (pathId: string, body?: string) => call(publishRoute.POST, "publish", pathId, body);

const row = (id: string) => db.learningPath.findUniqueOrThrow({ where: { id } });

afterEach(() => {
  vi.mocked(auth).mockReset();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("POST /api/org/paths/[pathId]/archive — authorization", () => {
  it("turns away everyone who is not an ORG_ADMIN of a tenant, whatever the body or the id, and archives nothing", async () => {
    const w = await pathWorld();
    const path = await w.makePath({ status: "PUBLISHED", courses: [await w.make()] });

    for (const [name, clerkId, status] of refusals(w)) {
      signInAs(clerkId);
      expect((await archive(path.id, "{}")).status, name).toBe(status);
      expect((await archive(path.id)).status, `${name}, no body`).toBe(status);
      expect((await archive("does-not-exist", "{{{")).status, `${name}, junk`).toBe(status);
    }
    expect((await row(path.id)).status).toBe("PUBLISHED");
  });
});

describe("POST /api/org/paths/[pathId]/archive", () => {
  it("archives a DRAFT, an empty DRAFT and a PUBLISHED path, with an empty body or {}", async () => {
    const w = await pathWorld();
    const draft = await w.makePath({ courses: [await w.make({ status: "DRAFT" })] });
    const empty = await w.makePath();
    const live = await w.makePath({ status: "PUBLISHED", courses: [await w.make()] });
    signInAs(w.admin.user.clerkId);

    for (const [path, body] of [
      [draft, "{}"],
      [empty, undefined],
      [live, ""],
    ] as const) {
      const res = await archive(path.id, body);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.path).toMatchObject({ id: path.id, status: "ARCHIVED" });
      expect((await row(path.id)).status).toBe("ARCHIVED");
      expect(JSON.stringify(json)).not.toContain(w.tenant.id);
    }
  });

  it("keeps the courses, their order and publishedAt", async () => {
    const w = await pathWorld();
    const [a, b] = await w.makeMany(2);
    if (!a || !b) throw new Error("fixture");
    const path = await w.makePath({ status: "PUBLISHED", courses: [a, b] });
    const before = await row(path.id);
    signInAs(w.admin.user.clerkId);

    const res = await archive(path.id, "{}");
    const json = await res.json();

    expect(
      json.path.courses.map((c: { courseId: string; position: number }) => [c.courseId, c.position])
    ).toEqual([
      [a.id, 1],
      [b.id, 2],
    ]);
    expect((await row(path.id)).publishedAt).toEqual(before.publishedAt);
    expect(await w.members(path.id)).toEqual([
      { courseId: a.id, position: 1 },
      { courseId: b.id, position: 2 },
    ]);
  });

  it("an already ARCHIVED path is 409 INVALID_TRANSITION and is not touched", async () => {
    const w = await pathWorld();
    const path = await w.makePath({ status: "ARCHIVED" });
    const before = await row(path.id);
    signInAs(w.admin.user.clerkId);

    const res = await archive(path.id, "{}");

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "INVALID_TRANSITION" });
    expect(await row(path.id)).toEqual(before);
  });

  it.each([
    ["a status", '{"status":"ARCHIVED"}'],
    ["a publishedAt", '{"publishedAt":null}'],
    ["a tenantId", '{"tenantId":"t"}'],
    ["a list", "[]"],
    ["malformed JSON", "{{{"],
  ])("refuses a body with %s with 400, and archives nothing", async (_name, body) => {
    const w = await pathWorld();
    const path = await w.makePath({ status: "PUBLISHED", courses: [await w.make()] });
    signInAs(w.admin.user.clerkId);

    const res = await archive(path.id, body);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_INPUT" });
    expect((await row(path.id)).status).toBe("PUBLISHED");
  });

  it("another tenant's path, an unknown path and a malformed id are the same 404, and the other path is untouched", async () => {
    const w = await pathWorld();
    const other = await pathWorld();
    const theirs = await other.makePath({ status: "PUBLISHED", courses: [await other.make()] });
    signInAs(w.admin.user.clerkId);

    const answers = await Promise.all(
      [theirs.id, "does-not-exist", "bad id!"].map(async (id) => {
        const res = await archive(id, "{}");
        return [res.status, await res.json()];
      })
    );

    expect(answers[0]).toEqual([404, { error: "Learning path not found", code: "NOT_FOUND" }]);
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
    expect((await row(theirs.id)).status).toBe("PUBLISHED");
  });

  it("8 simultaneous archives: one 200, seven 409 INVALID_TRANSITION, no 500", async () => {
    const w = await pathWorld();
    const path = await w.makePath({ status: "PUBLISHED", courses: [await w.make()] });
    signInAs(w.admin.user.clerkId);

    const responses = await Promise.all(Array.from({ length: 8 }, () => archive(path.id, "{}")));
    const bodies = await Promise.all(responses.map((r) => r.json()));

    expect(responses.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409, 409, 409, 409]);
    expect(bodies.filter((b) => b.code).every((b) => b.code === "INVALID_TRANSITION")).toBe(true);
  });

  it("answers a failure with a generic 500 and nothing internal", async () => {
    const w = await pathWorld();
    const path = await w.makePath({ status: "PUBLISHED", courses: [await w.make()] });
    signInAs(w.admin.user.clerkId);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(db, "$transaction").mockRejectedValueOnce(new Error("could not serialize access"));

    const res = await archive(path.id, "{}");
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: "Couldn't archive that learning path" });
    expect(text).not.toContain("serialize");
  });
});

describe("publish → archive → republish over HTTP", () => {
  it("runs the whole life, republishing on the courses as they are then, and never changes membership", async () => {
    const w = await pathWorld();
    const [a, b] = await w.makeMany(2);
    if (!a || !b) throw new Error("fixture");
    const path = await w.makePath({ courses: [a, b] });
    signInAs(w.admin.user.clerkId);

    const first = (await (await publish(path.id, "{}")).json()).path;
    await new Promise((r) => setTimeout(r, 15));
    const archived = (await (await archive(path.id, "{}")).json()).path;
    const second = (await (await publish(path.id, "{}")).json()).path;

    expect([first.status, archived.status, second.status]).toEqual([
      "PUBLISHED",
      "ARCHIVED",
      "PUBLISHED",
    ]);
    expect(archived.publishedAt).toEqual(first.publishedAt);
    expect(new Date(second.publishedAt).getTime()).toBeGreaterThan(
      new Date(first.publishedAt).getTime()
    );

    await archive(path.id, "{}");
    await w.archive(b.id);
    const refused = await publish(path.id, "{}");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      code: "PATH_NOT_PUBLISHABLE",
      problems: [{ kind: "COURSE", courseId: b.id, reason: "ARCHIVED" }],
    });
    expect((await row(path.id)).status).toBe("ARCHIVED");
    expect(await w.members(path.id)).toEqual([
      { courseId: a.id, position: 1 },
      { courseId: b.id, position: 2 },
    ]);
  });
});
