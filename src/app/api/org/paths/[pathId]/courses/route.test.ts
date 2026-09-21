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
  POST(jsonRequest(`http://localhost/api/org/paths/${pathId}/courses`, "POST", body, raw), {
    params: Promise.resolve({ pathId }),
  });

afterEach(() => {
  vi.mocked(auth).mockReset();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("POST /api/org/paths/[pathId]/courses", () => {
  it("turns away everyone who is not an ORG_ADMIN of a tenant, whatever the body, and adds nothing", async () => {
    const w = await pathWorld();
    const course = await w.make();
    const path = await w.makePath();

    for (const [name, clerkId, status] of refusals(w)) {
      signInAs(clerkId);
      expect((await post(path.id, { courseId: course.id })).status, name).toBe(status);
      expect((await post(path.id, "{{{", true)).status, `${name}, malformed`).toBe(status);
    }
    expect(await w.members(path.id)).toEqual([]);
  });

  it("adds a course at the end and returns the path", async () => {
    const w = await pathWorld();
    const [a, b] = await w.makeMany(2);
    if (!a || !b) throw new Error("fixture");
    const path = await w.makePath({ courses: [a] });
    signInAs(w.admin.user.clerkId);

    const res = await post(path.id, { courseId: b.id });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(
      body.path.courses.map((c: { courseId: string; position: number }) => [c.courseId, c.position])
    ).toEqual([
      [a.id, 1],
      [b.id, 2],
    ]);
  });

  it("refuses a duplicate with 409 DUPLICATE", async () => {
    const w = await pathWorld();
    const course = await w.make();
    const path = await w.makePath({ courses: [course] });
    signInAs(w.admin.user.clerkId);

    const res = await post(path.id, { courseId: course.id });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "DUPLICATE" });
    expect(await w.members(path.id)).toHaveLength(1);
  });

  it("refuses a 21st course with 409 LIMIT_REACHED", async () => {
    const w = await pathWorld();
    const courses = await w.makeMany(21);
    const path = await w.makePath({ courses: courses.slice(0, 20) });
    signInAs(w.admin.user.clerkId);

    const res = await post(path.id, { courseId: courses[20]?.id });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "LIMIT_REACHED" });
  });

  it("refuses an archived course with 409 COURSE_ARCHIVED and an archived path with 409 PATH_ARCHIVED", async () => {
    const w = await pathWorld();
    const archived = await w.make({ status: "ARCHIVED" });
    const draftPath = await w.makePath();
    const archivedPath = await w.makePath({ status: "ARCHIVED" });
    const live = await w.make();
    signInAs(w.admin.user.clerkId);

    const course = await post(draftPath.id, { courseId: archived.id });
    const path = await post(archivedPath.id, { courseId: live.id });

    expect(course.status).toBe(409);
    expect(await course.json()).toMatchObject({ code: "COURSE_ARCHIVED" });
    expect(path.status).toBe(409);
    expect(await path.json()).toMatchObject({ code: "PATH_ARCHIVED" });
  });

  it("refuses a course that cannot join a published path with 409 and says which course and why", async () => {
    const w = await pathWorld();
    const path = await w.makePath({ status: "PUBLISHED", courses: [await w.make()] });
    const draft = await w.make({ status: "DRAFT" });
    signInAs(w.admin.user.clerkId);

    const res = await post(path.id, { courseId: draft.id });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "The path can't be published yet",
      code: "PATH_NOT_PUBLISHABLE",
      problems: [
        { kind: "COURSE", courseId: draft.id, title: draft.title, reason: "NOT_PUBLISHED" },
      ],
    });
  });

  it("a tenantless course, another tenant's course (archived or not) and an unknown course are the same 404", async () => {
    const w = await pathWorld();
    const path = await w.makePath();
    const answers = [];
    signInAs(w.admin.user.clerkId);

    for (const id of [
      (await w.makeTenantless()).id,
      (await w.makeForeign()).id,
      (await w.makeForeign({ status: "ARCHIVED" })).id,
      "does-not-exist",
    ]) {
      const res = await post(path.id, { courseId: id });
      answers.push([res.status, await res.json()]);
    }

    expect(answers[0]).toEqual([404, { error: "Course not found", code: "COURSE_NOT_FOUND" }]);
    for (const answer of answers) expect(answer).toEqual(answers[0]);
    expect(await w.members(path.id)).toEqual([]);
  });

  it("another tenant's path and an unknown path are the same 404", async () => {
    const w = await pathWorld();
    const other = await pathWorld();
    const theirs = await other.makePath();
    const course = await w.make();
    signInAs(w.admin.user.clerkId);

    const foreign = await post(theirs.id, { courseId: course.id });
    const unknown = await post("does-not-exist", { courseId: course.id });

    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual(await unknown.json());
    expect(await other.members(theirs.id)).toEqual([]);
  });

  it.each([
    ["a position", { courseId: "x", position: 1 }],
    ["a forged tenantId", { courseId: "x", tenantId: "t" }],
    ["a forged status", { courseId: "x", status: "PUBLISHED" }],
    ["an unknown key", { courseId: "x", mystery: 1 }],
    ["no courseId", {}],
    ["a numeric courseId", { courseId: 5 }],
    ["a malformed courseId", { courseId: "bad id!" }],
    ["a list", ["x"]],
    ["null", null],
  ])("refuses a body with %s with 400", async (_name, body) => {
    const w = await pathWorld();
    const path = await w.makePath();
    signInAs(w.admin.user.clerkId);

    const res = await post(path.id, body);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_INPUT" });
    expect(await w.members(path.id)).toEqual([]);
  });

  it("refuses a body that is not JSON with 400", async () => {
    const w = await pathWorld();
    const path = await w.makePath();
    signInAs(w.admin.user.clerkId);

    expect((await post(path.id, "{{{", true)).status).toBe(400);
  });

  it("answers a failure with a generic 500 and nothing internal", async () => {
    const w = await pathWorld();
    const path = await w.makePath();
    const course = await w.make();
    signInAs(w.admin.user.clerkId);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(db, "$transaction").mockRejectedValueOnce(new Error("could not serialize access"));

    const res = await post(path.id, { courseId: course.id });
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: "Couldn't add that course to the path" });
    expect(text).not.toContain("serialize");
  });
});

describe("POST /api/org/paths/[pathId]/courses — concurrency", () => {
  it("8 simultaneous requests for the same course: one 201, seven 409 DUPLICATE, no 500", async () => {
    const w = await pathWorld();
    const course = await w.make();
    const path = await w.makePath();
    signInAs(w.admin.user.clerkId);

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => post(path.id, { courseId: course.id }))
    );
    const bodies = await Promise.all(responses.map((r) => r.json()));

    expect(responses.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409, 409, 409, 409]);
    expect(bodies.filter((b) => b.code).every((b) => b.code === "DUPLICATE")).toBe(true);
    expect(await w.members(path.id)).toEqual([{ courseId: course.id, position: 1 }]);
  });
});
