import { auth } from "@clerk/nextjs/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { prerequisiteWorld } from "@/lib/domain/course/__test__/prerequisiteFixtures";
import { createScenario, createUserIn } from "@/lib/domain/learning-assignment/__test__/fixtures";
import { GET } from "./route";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));

type World = Awaited<ReturnType<typeof prerequisiteWorld>>;

const get = (slug: string, search = "") =>
  GET(new Request(`http://localhost/api/courses/${slug}/prerequisite-status${search}`), {
    params: Promise.resolve({ courseId: slug }),
  });

const signInAs = (clerkId: string | null) =>
  vi.mocked(auth).mockResolvedValue({ userId: clerkId } as never);

afterEach(() => {
  vi.mocked(auth).mockReset();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

async function threeStates(w: World) {
  const [done, needed, retired] = await Promise.all([w.make(), w.make(), w.make()]);
  for (const p of [done, needed, retired]) await w.requires(w.course.id, p.id);
  await w.complete(w.learner.user.id, done.id);
  await w.archive(retired.id);
  return { done, needed, retired };
}

describe("GET /api/courses/[courseId]/prerequisite-status — the learner's own view", () => {
  it("reports COMPLETED, REQUIRED and NON_ENFORCEABLE for the signed-in learner", async () => {
    const w = await prerequisiteWorld();
    const { done, needed } = await threeStates(w);
    signInAs(w.learner.user.clerkId);

    const res = await get(w.course.slug);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      prerequisites: [
        { courseId: done.id, slug: done.slug, title: done.title, status: "COMPLETED" },
        { courseId: needed.id, slug: needed.slug, title: needed.title, status: "REQUIRED" },
        { status: "NON_ENFORCEABLE" },
      ],
    });
  });

  it("a draft prerequisite reaches the learner as a bare NON_ENFORCEABLE: no title, slug or id anywhere in the body", async () => {
    const w = await prerequisiteWorld();
    const [live, draft] = await Promise.all([w.make(), w.make()]);
    await w.requires(w.course.id, live.id);
    await w.requires(w.course.id, draft.id);
    await w.unpublish(draft.id);
    signInAs(w.learner.user.clerkId);

    const res = await get(w.course.slug);
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual({
      prerequisites: [
        { courseId: live.id, slug: live.slug, title: live.title, status: "REQUIRED" },
        { status: "NON_ENFORCEABLE" },
      ],
    });
    for (const revealing of [draft.id, draft.slug, draft.title]) {
      expect(text).not.toContain(revealing);
    }
  });

  it("a prerequisite the learner completed before it was archived or unpublished still shows as COMPLETED", async () => {
    const w = await prerequisiteWorld();
    const [archived, draft] = await Promise.all([w.make(), w.make()]);
    for (const p of [archived, draft]) {
      await w.requires(w.course.id, p.id);
      await w.complete(w.learner.user.id, p.id);
    }
    await w.archive(archived.id);
    await w.unpublish(draft.id);
    signInAs(w.learner.user.clerkId);

    expect(await (await get(w.course.slug)).json()).toEqual({
      prerequisites: [
        { courseId: archived.id, slug: archived.slug, title: archived.title, status: "COMPLETED" },
        { courseId: draft.id, slug: draft.slug, title: draft.title, status: "COMPLETED" },
      ],
    });
  });

  it("a course with no prerequisites answers an empty list, not an error", async () => {
    const w = await prerequisiteWorld();
    signInAs(w.learner.user.clerkId);

    const res = await get(w.course.slug);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ prerequisites: [] });
  });

  it("is per learner: learner A cannot observe learner B's completion, and a URL cannot ask for another learner", async () => {
    const w = await prerequisiteWorld();
    const a = await w.make();
    await w.requires(w.course.id, a.id);
    const other = await createUserIn(w.tenant.id, "STUDENT");
    await w.complete(other.user.id, a.id);

    signInAs(w.learner.user.clerkId);
    const mine = await (
      await get(w.course.slug, `?userId=${other.user.id}&learnerId=${other.user.id}`)
    ).json();
    signInAs(other.user.clerkId);
    const theirs = await (await get(w.course.slug)).json();

    expect(mine.prerequisites[0].status).toBe("REQUIRED");
    expect(theirs.prerequisites[0].status).toBe("COMPLETED");
    expect(JSON.stringify(mine)).not.toContain(other.user.id);
  });

  it("never returns a prerequisite of another tenant, even one forced into the table", async () => {
    const w = await prerequisiteWorld();
    const foreign = await prerequisiteWorld();
    await w.requires(w.course.id, foreign.course.id);
    signInAs(w.learner.user.clerkId);

    expect(await (await get(w.course.slug)).json()).toEqual({ prerequisites: [] });
  });

  it("a tenantless (open catalogue) course is visible and has no prerequisites to report", async () => {
    const w = await prerequisiteWorld();
    const open = await db.course.create({
      data: {
        title: "open",
        slug: `open-${Math.random()}`,
        instructorId: w.instructor.user.id,
        tenantId: null,
        status: "PUBLISHED",
      },
    });
    signInAs(w.learner.user.clerkId);

    const res = await get(open.slug);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ prerequisites: [] });
  });
});

describe("GET prerequisite-status — access and non-disclosure", () => {
  it("401 without a session and 403 for anyone who is not a student", async () => {
    const w = await prerequisiteWorld();
    signInAs(null);
    expect((await get(w.course.slug)).status).toBe(401);

    for (const actor of [w.instructor, w.admin]) {
      signInAs(actor.user.clerkId);
      expect((await get(w.course.slug)).status, actor.user.role).toBe(403);
    }
  });

  it("an unknown course, another tenant's course and a draft are the same 404", async () => {
    const w = await prerequisiteWorld();
    const a = await w.make();
    await w.requires(w.course.id, a.id);
    const draft = await w.make({ status: "DRAFT" });
    const outsider = await createScenario();
    signInAs(outsider.learner.user.clerkId);

    const foreign = await get(w.course.slug);
    const unknown = await get("does-not-exist");
    signInAs(w.learner.user.clerkId);
    const unpublished = await get(draft.slug);

    for (const res of [foreign, unknown, unpublished]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Course not found" });
    }
  });

  it("an archived course is visible only to a learner who is enrolled in it", async () => {
    const w = await prerequisiteWorld();
    const a = await w.make();
    await w.requires(w.course.id, a.id);
    await w.archive(w.course.id);
    signInAs(w.learner.user.clerkId);
    expect((await get(w.course.slug)).status).toBe(404);

    await w.enroll(w.learner.user.id, w.course.id, "ACTIVE");
    const res = await get(w.course.slug);

    expect(res.status).toBe(200);
    expect((await res.json()).prerequisites).toHaveLength(1);
  });

  it("a learner with no tenant gets a 404 for a tenant-owned course", async () => {
    const w = await prerequisiteWorld();
    const tenantless = await db.user.create({
      data: {
        clerkId: `t-${Math.random()}`,
        email: `t-${Math.random()}@example.test`,
        role: "STUDENT",
      },
    });
    signInAs(tenantless.clerkId);

    expect((await get(w.course.slug)).status).toBe(404);
  });

  it("does not write anything", async () => {
    const w = await prerequisiteWorld();
    await threeStates(w);
    const before = await Promise.all([
      db.enrollment.count(),
      db.coursePrerequisite.count(),
      db.notification.count(),
    ]);
    signInAs(w.learner.user.clerkId);

    await get(w.course.slug);

    expect(
      await Promise.all([
        db.enrollment.count(),
        db.coursePrerequisite.count(),
        db.notification.count(),
      ])
    ).toEqual(before);
  });

  it("a failure is a generic 500 with nothing internal in it", async () => {
    const w = await prerequisiteWorld();
    signInAs(w.learner.user.clerkId);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(db.coursePrerequisite, "findMany").mockRejectedValueOnce(
      new Error('relation "CoursePrerequisite" does not exist')
    );
    await w.requires(w.course.id, (await w.make()).id);

    const res = await get(w.course.slug);
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: "Failed to load prerequisites" });
    expect(text).not.toContain("CoursePrerequisite");
  });
});

describe("GET prerequisite-status — bounded queries", () => {
  it("reads the prerequisites in one query and their lessons and enrollments in one each, whether the course has 1 or 5", async () => {
    async function measure(n: number) {
      const w = await prerequisiteWorld();
      for (let i = 0; i < n; i++) await w.requires(w.course.id, (await w.make()).id);
      signInAs(w.learner.user.clerkId);
      const spies = [
        vi.spyOn(db.coursePrerequisite, "findMany"),
        vi.spyOn(db.section, "findMany"),
        vi.spyOn(db.enrollment, "findMany"),
      ];
      const res = await get(w.course.slug);
      const calls = spies.map((s) => s.mock.calls.length);
      vi.restoreAllMocks();
      return { calls, count: (await res.json()).prerequisites.length };
    }

    const one = await measure(1);
    const five = await measure(5);

    expect(one.count).toBe(1);
    expect(five.count).toBe(5);
    expect(five.calls).toEqual(one.calls);
    expect(five.calls).toEqual([1, 1, 1]);
  });
});
