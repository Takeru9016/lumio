import { auth } from "@clerk/nextjs/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { pathWorld } from "@/lib/domain/learning-path/__test__/pathWorld";
import { refusals } from "@/lib/domain/learning-path/__test__/routeAuth";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));

const { DELETE } = await import("./route");

const signInAs = (clerkId: string | null) =>
  vi.mocked(auth).mockResolvedValue({ userId: clerkId } as never);

const del = (pathId: string, courseId: string) =>
  DELETE(
    new Request(`http://localhost/api/org/paths/${pathId}/courses/${courseId}`, {
      method: "DELETE",
    }),
    {
      params: Promise.resolve({ pathId, courseId }),
    }
  );

afterEach(() => {
  vi.mocked(auth).mockReset();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("DELETE /api/org/paths/[pathId]/courses/[courseId]", () => {
  it("turns away everyone who is not an ORG_ADMIN of a tenant, whatever the ids, and removes nothing", async () => {
    const w = await pathWorld();
    const course = await w.make();
    const path = await w.makePath({ courses: [course] });

    for (const [name, clerkId, status] of refusals(w)) {
      signInAs(clerkId);
      expect((await del(path.id, course.id)).status, name).toBe(status);
      expect((await del("nope", "nope")).status, `${name}, unknown ids`).toBe(status);
    }
    expect(await w.memberIds(path.id)).toEqual([course.id]);
  });

  it("removes a course, renumbers the rest and returns the path", async () => {
    const w = await pathWorld();
    const [a, b, c] = await w.makeMany(3);
    if (!a || !b || !c) throw new Error("fixture");
    const path = await w.makePath({ courses: [a, b, c] });
    signInAs(w.admin.user.clerkId);

    const res = await del(path.id, a.id);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(
      body.path.courses.map((x: { courseId: string; position: number }) => [x.courseId, x.position])
    ).toEqual([
      [b.id, 1],
      [c.id, 2],
    ]);
    expect(await db.course.count({ where: { id: a.id } })).toBe(1);
  });

  it("refuses to empty a PUBLISHED path with 409 LAST_COURSE", async () => {
    const w = await pathWorld();
    const course = await w.make();
    const path = await w.makePath({ status: "PUBLISHED", courses: [course] });
    signInAs(w.admin.user.clerkId);

    const res = await del(path.id, course.id);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "LAST_COURSE" });
    expect(await w.memberIds(path.id)).toEqual([course.id]);
  });

  it("refuses removing a healthy course that would leave a broken one, naming the blocker, but lets the broken one go", async () => {
    const w = await pathWorld();
    const [good, spare, broken] = await w.makeMany(3);
    if (!good || !spare || !broken) throw new Error("fixture");
    const path = await w.makePath({ status: "PUBLISHED", courses: [good, spare, broken] });
    await w.archive(broken.id);
    signInAs(w.admin.user.clerkId);

    const refused = await del(path.id, good.id);
    const repaired = await del(path.id, broken.id);

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      code: "PATH_NOT_PUBLISHABLE",
      problems: [{ kind: "COURSE", courseId: broken.id, reason: "ARCHIVED" }],
    });
    expect(repaired.status).toBe(200);
    expect(await w.memberIds(path.id)).toEqual([good.id, spare.id]);
  });

  it("refuses an ARCHIVED path with 409 PATH_ARCHIVED", async () => {
    const w = await pathWorld();
    const course = await w.make();
    const path = await w.makePath({ status: "ARCHIVED", courses: [course] });
    signInAs(w.admin.user.clerkId);

    const res = await del(path.id, course.id);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "PATH_ARCHIVED" });
  });

  it("a course that is not in the path is 404, whether it is the tenant's, another tenant's, unknown or malformed", async () => {
    const w = await pathWorld();
    const member = await w.make();
    const path = await w.makePath({ courses: [member] });
    const answers = [];
    signInAs(w.admin.user.clerkId);

    for (const id of [
      (await w.make()).id,
      (await w.makeForeign()).id,
      "does-not-exist",
      "bad id!",
    ]) {
      const res = await del(path.id, id);
      answers.push([res.status, await res.json()]);
    }

    expect(answers[0]).toEqual([404, { error: "Course not found", code: "COURSE_NOT_FOUND" }]);
    for (const answer of answers) expect(answer).toEqual(answers[0]);
    expect(await w.memberIds(path.id)).toEqual([member.id]);
  });

  it("another tenant's path and an unknown path are the same 404, and the other path keeps its course", async () => {
    const w = await pathWorld();
    const other = await pathWorld();
    const theirCourse = await other.make();
    const theirs = await other.makePath({ courses: [theirCourse] });
    signInAs(w.admin.user.clerkId);

    const foreign = await del(theirs.id, theirCourse.id);
    const unknown = await del("does-not-exist", theirCourse.id);

    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual(await unknown.json());
    expect(await other.memberIds(theirs.id)).toEqual([theirCourse.id]);
  });

  it("answers a failure with a generic 500 and nothing internal", async () => {
    const w = await pathWorld();
    const course = await w.make();
    const path = await w.makePath({ courses: [course] });
    signInAs(w.admin.user.clerkId);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(db, "$transaction").mockRejectedValueOnce(new Error("could not serialize access"));

    const res = await del(path.id, course.id);
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: "Couldn't remove that course from the path" });
    expect(text).not.toContain("serialize");
  });
});
