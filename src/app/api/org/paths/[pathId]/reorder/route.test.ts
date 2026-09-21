import { auth } from "@clerk/nextjs/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { pathWorld } from "@/lib/domain/learning-path/__test__/pathWorld";
import { jsonRequest, refusals } from "@/lib/domain/learning-path/__test__/routeAuth";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));

const { POST } = await import("./route");

const signInAs = (clerkId: string | null) =>
  vi.mocked(auth).mockResolvedValue({ userId: clerkId } as never);

const post = (pathId: string, body: unknown, raw = false) =>
  POST(jsonRequest(`http://localhost/api/org/paths/${pathId}/reorder`, "POST", body, raw), {
    params: Promise.resolve({ pathId }),
  });

afterEach(() => {
  vi.mocked(auth).mockReset();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

async function three() {
  const w = await pathWorld();
  const [a, b, c] = await w.makeMany(3);
  if (!a || !b || !c) throw new Error("fixture");
  return { w, a, b, c, path: await w.makePath({ courses: [a, b, c] }) };
}

describe("POST /api/org/paths/[pathId]/reorder", () => {
  it("turns away everyone who is not an ORG_ADMIN of a tenant, whatever the body, and reorders nothing", async () => {
    const { w, a, b, c, path } = await three();

    for (const [name, clerkId, status] of refusals(w)) {
      signInAs(clerkId);
      expect((await post(path.id, { courseIds: [c.id, b.id, a.id] })).status, name).toBe(status);
      expect((await post(path.id, "{{{", true)).status, `${name}, malformed`).toBe(status);
    }
    expect(await w.memberIds(path.id)).toEqual([a.id, b.id, c.id]);
  });

  it("orders the path as asked, positions 1..n, and returns it", async () => {
    const { w, a, b, c, path } = await three();
    signInAs(w.admin.user.clerkId);

    const res = await post(path.id, { courseIds: [c.id, a.id, b.id] });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(
      body.path.courses.map((x: { courseId: string; position: number }) => [x.courseId, x.position])
    ).toEqual([
      [c.id, 1],
      [a.id, 2],
      [b.id, 3],
    ]);
  });

  it("refuses a partial, extra or unknown list with 409 STALE_ORDER and changes nothing", async () => {
    const { w, a, b, c, path } = await three();
    signInAs(w.admin.user.clerkId);

    for (const courseIds of [
      [a.id, b.id],
      [a.id, b.id, c.id, "does-not-exist"],
      [a.id, b.id, "does-not-exist"],
    ]) {
      const res = await post(path.id, { courseIds });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "STALE_ORDER" });
    }
    expect(await w.memberIds(path.id)).toEqual([a.id, b.id, c.id]);
  });

  it.each([
    ["an empty list", () => ({ courseIds: [] })],
    ["a duplicate", (x: string[]) => ({ courseIds: [x[0], x[0], x[1]] })],
    ["a list that is not a list", () => ({ courseIds: "abc" })],
    ["a list of numbers", () => ({ courseIds: [1, 2, 3] })],
    ["positions instead of ids", () => ({ positions: [1, 2, 3] })],
    ["a position beside the ids", (x: string[]) => ({ courseIds: x, positions: [3, 2, 1] })],
    ["a forged tenantId", (x: string[]) => ({ courseIds: x, tenantId: "t" })],
    ["no body fields", () => ({})],
    ["a bare list", (x: string[]) => x],
    ["null", () => null],
  ])("refuses %s with 400 INVALID_INPUT and changes nothing", async (_name, build) => {
    const { w, a, b, c, path } = await three();
    signInAs(w.admin.user.clerkId);

    const res = await post(path.id, build([a.id, b.id, c.id]));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_INPUT" });
    expect(await w.memberIds(path.id)).toEqual([a.id, b.id, c.id]);
  });

  it("refuses a body that is not JSON with 400", async () => {
    const { w, path } = await three();
    signInAs(w.admin.user.clerkId);

    expect((await post(path.id, "{{{", true)).status).toBe(400);
  });

  it("refuses an ARCHIVED path with 409 PATH_ARCHIVED", async () => {
    const w = await pathWorld();
    const [a, b] = await w.makeMany(2);
    if (!a || !b) throw new Error("fixture");
    const path = await w.makePath({ status: "ARCHIVED", courses: [a, b] });
    signInAs(w.admin.user.clerkId);

    const res = await post(path.id, { courseIds: [b.id, a.id] });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "PATH_ARCHIVED" });
    expect(await w.memberIds(path.id)).toEqual([a.id, b.id]);
  });

  it("another tenant's path and an unknown path are the same 404, and the other path keeps its order", async () => {
    const w = await pathWorld();
    const other = await pathWorld();
    const [x, y] = await other.makeMany(2);
    if (!x || !y) throw new Error("fixture");
    const theirs = await other.makePath({ courses: [x, y] });
    signInAs(w.admin.user.clerkId);

    const foreign = await post(theirs.id, { courseIds: [y.id, x.id] });
    const unknown = await post("does-not-exist", { courseIds: [y.id, x.id] });

    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual(await unknown.json());
    expect(await other.memberIds(theirs.id)).toEqual([x.id, y.id]);
  });

  it("answers a failure with a generic 500 and nothing internal", async () => {
    const { w, a, b, c, path } = await three();
    signInAs(w.admin.user.clerkId);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(db, "$transaction").mockRejectedValueOnce(new Error("could not serialize access"));

    const res = await post(path.id, { courseIds: [c.id, b.id, a.id] });
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: "Couldn't reorder that learning path" });
    expect(text).not.toContain("serialize");
  });
});
