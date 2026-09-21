import { auth } from "@clerk/nextjs/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { learnerWorld } from "@/lib/domain/learner-path/__test__/learnerWorld";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));

const routeModule = await import("./route");
const { GET } = routeModule;

const signInAs = (clerkId: string | null) =>
  vi.mocked(auth).mockResolvedValue({ userId: clerkId } as never);

const get = (pathId: string, search = "") =>
  GET(new Request(`http://localhost/api/paths/${pathId}${search}`), {
    params: Promise.resolve({ pathId }),
  });

afterEach(() => {
  vi.mocked(auth).mockReset();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("GET /api/paths/[pathId] — who may ask", () => {
  it("401 without a session, and for a Clerk user with no Lumio row", async () => {
    const w = await learnerWorld();
    const path = await w.publishedPath([await w.make()]);

    signInAs(null);
    expect((await get(path.id)).status).toBe(401);
    signInAs("clerk_never_synced");
    expect((await get(path.id)).status).toBe(401);
  });

  it("403 for an instructor, an ORG_ADMIN and a SUPER_ADMIN, whatever the id", async () => {
    const w = await learnerWorld();
    const path = await w.publishedPath([await w.make()]);

    for (const [name, clerkId] of [
      ["INSTRUCTOR", w.instructor.user.clerkId],
      ["ORG_ADMIN", w.admin.user.clerkId],
      ["SUPER_ADMIN", w.superAdmin.user.clerkId],
    ] as const) {
      signInAs(clerkId);
      expect((await get(path.id)).status, name).toBe(403);
      expect((await get("does-not-exist")).status, `${name}, unknown id`).toBe(403);
    }
  });

  it("400 for a student with no organisation, 403 for a student whose account was deleted", async () => {
    const w = await learnerWorld();
    const path = await w.publishedPath([await w.make()]);
    const solo = await db.user.create({
      data: {
        clerkId: `solo-${Date.now()}`,
        email: `solo-${Date.now()}@example.test`,
        role: "STUDENT",
      },
    });
    signInAs(solo.clerkId);
    expect((await get(path.id)).status).toBe(400);

    await db.user.update({ where: { id: w.learner.user.id }, data: { deletedAt: new Date() } });
    signInAs(w.learner.user.clerkId);
    expect((await get(path.id)).status).toBe(403);
  });

  it("exports nothing but GET", () => {
    expect(Object.keys(routeModule).filter((k) => /^(POST|PUT|PATCH|DELETE)$/.test(k))).toEqual([]);
  });
});

describe("GET /api/paths/[pathId]", () => {
  it("returns the path with each course's availability, in order, and only learner-safe fields", async () => {
    const w = await learnerWorld();
    const [done, open, blocked, prerequisite, draft] = await Promise.all([
      w.make(),
      w.make(),
      w.make(),
      w.make(),
      w.make({ status: "DRAFT" }),
    ]);
    await w.requires(blocked.id, prerequisite.id);
    await w.complete(done.id);
    const path = await w.publishedPath([done, open, blocked, draft], "Leadership");
    signInAs(w.learner.user.clerkId);

    const res = await get(path.id);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      path: {
        id: path.id,
        title: "Leadership",
        description: null,
        status: "PUBLISHED",
        publishedAt: expect.any(String),
        courses: [
          {
            courseId: done.id,
            slug: done.slug,
            title: done.title,
            position: 1,
            availability: "COMPLETED",
            prerequisiteState: "NONE",
          },
          {
            courseId: open.id,
            slug: open.slug,
            title: open.title,
            position: 2,
            availability: "AVAILABLE",
            prerequisiteState: "NONE",
          },
          {
            courseId: blocked.id,
            position: 3,
            availability: "UNAVAILABLE",
            prerequisiteState: "UNMET",
          },
          { position: 4, availability: "UNAVAILABLE", prerequisiteState: "NONE" },
        ],
        progress: { completed: 1, available: 1, percentage: 50 },
      },
    });
    const text = JSON.stringify(body);
    for (const secret of [
      blocked.slug,
      blocked.title,
      prerequisite.id,
      prerequisite.slug,
      prerequisite.title,
      draft.id,
      draft.slug,
      draft.title,
      w.tenant.id,
      w.admin.user.id,
      w.instructor.user.id,
    ]) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it("a draft, an archived path, another tenant's path, an unknown id and a malformed id are one and the same 404", async () => {
    const w = await learnerWorld();
    const other = await learnerWorld();
    const course = await w.make();
    const draft = await w.makePath({ courses: [course] });
    const archived = await w.makePath({ status: "ARCHIVED", courses: [course] });
    const foreign = await other.publishedPath([await other.make()]);
    signInAs(w.learner.user.clerkId);

    const answers = await Promise.all(
      [draft.id, archived.id, foreign.id, "does-not-exist", "bad id!"].map(async (id) => {
        const res = await get(id);
        return [res.status, await res.json()];
      })
    );

    expect(answers[0]).toEqual([404, { error: "Learning path not found", code: "NOT_FOUND" }]);
    for (const answer of answers) expect(answer).toEqual(answers[0]);
  });

  it("takes the learner and the tenant from the session only: a user or tenant in the URL changes nothing", async () => {
    const w = await learnerWorld();
    const other = await w.otherLearner();
    const course = await w.make();
    await w.complete(course.id, other.user.id);
    const path = await w.publishedPath([course]);
    signInAs(w.learner.user.clerkId);

    const body = await (
      await get(path.id, `?userId=${other.user.id}&tenantId=${w.tenant.id}`)
    ).json();

    expect(body.path.progress.completed).toBe(0);
    expect(JSON.stringify(body)).not.toContain(other.user.id);
  });

  it("answers a failure with a generic 500 and nothing internal", async () => {
    const w = await learnerWorld();
    const path = await w.publishedPath([await w.make()]);
    signInAs(w.learner.user.clerkId);
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
