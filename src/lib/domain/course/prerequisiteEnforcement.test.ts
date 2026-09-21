import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { prerequisiteWorld } from "@/lib/domain/course/__test__/prerequisiteFixtures";
import {
  assertCoursePrerequisitesMet,
  CoursePrerequisiteError,
  getLearnerPrerequisiteStatuses,
  getUnmetPrerequisites,
  PrerequisitesNotMetError,
} from "@/lib/domain/course/prerequisites";
import { createScenario, createUserIn } from "@/lib/domain/learning-assignment/__test__/fixtures";

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

type World = Awaited<ReturnType<typeof prerequisiteWorld>>;

const check = (w: World, userId = w.learner.user.id) =>
  assertCoursePrerequisitesMet(db, { userId, courseId: w.course.id });

const statuses = (w: World, userId = w.learner.user.id) =>
  getLearnerPrerequisiteStatuses(db, { userId, courseId: w.course.id });

async function thrown(promise: Promise<unknown>): Promise<PrerequisitesNotMetError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof PrerequisitesNotMetError) return err;
    throw err;
  }
  throw new Error("expected PREREQUISITES_NOT_MET");
}

describe("assertCoursePrerequisitesMet", () => {
  it("passes for a course with no prerequisites", async () => {
    const w = await prerequisiteWorld();

    expect(await check(w)).toEqual([]);
  });

  it("passes when every prerequisite is completed, and says so", async () => {
    const w = await prerequisiteWorld();
    const [a, b] = await Promise.all([w.make(), w.make()]);
    await w.requires(w.course.id, a.id);
    await w.requires(w.course.id, b.id);
    await w.complete(w.learner.user.id, a.id);
    await w.complete(w.learner.user.id, b.id);

    const result = await check(w);

    expect(result.map((r) => r.status)).toEqual(["COMPLETED", "COMPLETED"]);
  });

  it("one unmet prerequisite blocks, with a structured PREREQUISITES_NOT_MET", async () => {
    const w = await prerequisiteWorld();
    const a = await w.make();
    await w.requires(w.course.id, a.id);

    const err = await thrown(check(w));

    expect(err.code).toBe("PREREQUISITES_NOT_MET");
    expect(err.status).toBe(409);
    expect(err).toBeInstanceOf(CoursePrerequisiteError);
    expect(err.prerequisites).toEqual([{ courseId: a.id, slug: a.slug, title: a.title }]);
  });

  it("is distinguishable from the other prerequisite errors by code", async () => {
    const w = await prerequisiteWorld();
    const a = await w.make();
    await w.requires(w.course.id, a.id);

    const err = await thrown(check(w));

    for (const other of ["NOT_FOUND", "FORBIDDEN", "COURSE_ARCHIVED", "DUPLICATE", "CYCLE"]) {
      expect(err.code).not.toBe(other);
    }
    expect(err.message).toBe("Complete the prerequisite courses first");
    expect(err.message).not.toContain(a.id);
  });

  it("several unmet prerequisites are all reported, in the order they were added, and completed ones are not", async () => {
    const w = await prerequisiteWorld();
    const [a, b, c] = await Promise.all([w.make(), w.make(), w.make()]);
    await w.requires(w.course.id, a.id);
    await w.requires(w.course.id, b.id);
    await w.requires(w.course.id, c.id);
    await w.complete(w.learner.user.id, b.id);

    const err = await thrown(check(w));

    expect(err.prerequisites.map((p) => p.slug)).toEqual([a.slug, c.slug]);
  });

  it("all prerequisites are required (AND): one completed of two still blocks", async () => {
    const w = await prerequisiteWorld();
    const [a, b] = await Promise.all([w.make(), w.make()]);
    await w.requires(w.course.id, a.id);
    await w.requires(w.course.id, b.id);
    await w.complete(w.learner.user.id, a.id);

    expect((await thrown(check(w))).prerequisites.map((p) => p.slug)).toEqual([b.slug]);
  });

  it.each(["ACTIVE", "REFUNDED"] as const)(
    "only COMPLETED satisfies: an %s enrollment on the prerequisite does not",
    async (status) => {
      const w = await prerequisiteWorld();
      const a = await w.make();
      await w.requires(w.course.id, a.id);
      await w.enroll(w.learner.user.id, a.id, status);

      expect((await thrown(check(w))).prerequisites).toHaveLength(1);
    }
  );

  it("not enrolled at all is unmet", async () => {
    const w = await prerequisiteWorld();
    const a = await w.make();
    await w.requires(w.course.id, a.id);

    expect((await thrown(check(w))).prerequisites).toHaveLength(1);
  });

  it.each([
    ["archived", (w: World, id: string) => w.archive(id)],
    ["a draft", (w: World, id: string) => w.unpublish(id)],
    ["without a published lesson", (w: World, id: string) => w.removeLessons(id)],
  ])("a prerequisite that is %s is non-enforceable and never blocks", async (_name, retire) => {
    const w = await prerequisiteWorld();
    const a = await w.make();
    await w.requires(w.course.id, a.id);
    await retire(w, a.id);

    const result = await check(w);

    expect(result.map((r) => r.status)).toEqual(["NON_ENFORCEABLE"]);
  });

  it("a completed prerequisite that is later archived is still satisfied", async () => {
    const w = await prerequisiteWorld();
    const a = await w.make();
    await w.requires(w.course.id, a.id);
    await w.complete(w.learner.user.id, a.id);
    await w.archive(a.id);

    expect((await check(w)).map((r) => r.status)).toEqual(["COMPLETED"]);
  });

  it("an archived prerequisite is not an error: the course stays reachable", async () => {
    const w = await prerequisiteWorld();
    const [live, retired] = await Promise.all([w.make(), w.make()]);
    await w.requires(w.course.id, live.id);
    await w.requires(w.course.id, retired.id);
    await w.archive(retired.id);

    const err = await thrown(check(w));

    expect(err.prerequisites.map((p) => p.slug)).toEqual([live.slug]);
  });

  it("changes nothing: no enrollment, no notification, no edge", async () => {
    const w = await prerequisiteWorld();
    const a = await w.make();
    await w.requires(w.course.id, a.id);
    const before = await Promise.all([
      db.enrollment.count(),
      db.notification.count(),
      db.coursePrerequisite.count(),
    ]);

    await thrown(check(w));

    expect(
      await Promise.all([
        db.enrollment.count(),
        db.notification.count(),
        db.coursePrerequisite.count(),
      ])
    ).toEqual(before);
  });

  it("works on a transaction client, seeing that transaction's own writes", async () => {
    const w = await prerequisiteWorld();
    const a = await w.make();
    await w.requires(w.course.id, a.id);

    const result = await db.$transaction(async (tx) => {
      await tx.enrollment.create({
        data: {
          userId: w.learner.user.id,
          courseId: a.id,
          status: "COMPLETED",
          completedAt: new Date(),
        },
      });
      return assertCoursePrerequisitesMet(tx, {
        userId: w.learner.user.id,
        courseId: w.course.id,
      });
    });

    expect(result.map((r) => r.status)).toEqual(["COMPLETED"]);
  });
});

describe("getLearnerPrerequisiteStatuses", () => {
  it("reports COMPLETED and REQUIRED with course id, slug and title, and NON_ENFORCEABLE with nothing else", async () => {
    const w = await prerequisiteWorld();
    const [done, needed, retired] = await Promise.all([w.make(), w.make(), w.make()]);
    for (const p of [done, needed, retired]) await w.requires(w.course.id, p.id);
    await w.complete(w.learner.user.id, done.id);
    await w.archive(retired.id);

    expect(await statuses(w)).toEqual([
      { courseId: done.id, slug: done.slug, title: done.title, status: "COMPLETED" },
      { courseId: needed.id, slug: needed.slug, title: needed.title, status: "REQUIRED" },
      { status: "NON_ENFORCEABLE" },
    ]);
  });

  describe("what each state discloses to a learner", () => {
    const disclosed = (p: { id: string; slug: string; title: string }, status: string) => ({
      courseId: p.id,
      slug: p.slug,
      title: p.title,
      status,
    });

    it("PUBLISHED with a published lesson, not completed: REQUIRED with course id, slug and title", async () => {
      const w = await prerequisiteWorld();
      const a = await w.make();
      await w.requires(w.course.id, a.id);

      expect(await statuses(w)).toEqual([disclosed(a, "REQUIRED")]);
    });

    it("PUBLISHED with a published lesson, completed: COMPLETED with course id, slug and title", async () => {
      const w = await prerequisiteWorld();
      const a = await w.make();
      await w.requires(w.course.id, a.id);
      await w.complete(w.learner.user.id, a.id);

      expect(await statuses(w)).toEqual([disclosed(a, "COMPLETED")]);
    });

    it.each([
      ["a draft", (w: World, id: string) => w.unpublish(id)],
      ["archived", (w: World, id: string) => w.archive(id)],
      ["published without a published lesson", (w: World, id: string) => w.removeLessons(id)],
    ])(
      "%s and not completed: exactly { status: NON_ENFORCEABLE }, nothing that names the course",
      async (_name, retire) => {
        const w = await prerequisiteWorld();
        const a = await w.make();
        await w.requires(w.course.id, a.id);
        await retire(w, a.id);

        const result = await statuses(w);

        expect(result).toEqual([{ status: "NON_ENFORCEABLE" }]);
        expect(Object.keys(result[0])).toEqual(["status"]);
        const json = JSON.stringify(result);
        for (const revealing of [a.id, a.slug, a.title, w.tenant.id]) {
          expect(json).not.toContain(revealing);
        }
      }
    );

    it.each([
      ["archived", (w: World, id: string) => w.archive(id)],
      ["unpublished to a draft", (w: World, id: string) => w.unpublish(id)],
      ["stripped of its published lessons", (w: World, id: string) => w.removeLessons(id)],
    ])(
      "completed and then %s: still COMPLETED with course id, slug and title",
      async (_name, retire) => {
        const w = await prerequisiteWorld();
        const a = await w.make();
        await w.requires(w.course.id, a.id);
        await w.complete(w.learner.user.id, a.id);
        await retire(w, a.id);

        expect(await statuses(w)).toEqual([disclosed(a, "COMPLETED")]);
      }
    );

    it("a mix keeps its order, and only the retired entries are stripped", async () => {
      const w = await prerequisiteWorld();
      const [live, draft, done, archived] = await Promise.all(
        Array.from({ length: 4 }, () => w.make())
      );
      for (const p of [live, draft, done, archived]) await w.requires(w.course.id, p.id);
      await w.unpublish(draft.id);
      await w.complete(w.learner.user.id, done.id);
      await w.archive(archived.id);

      expect(await statuses(w)).toEqual([
        disclosed(live, "REQUIRED"),
        { status: "NON_ENFORCEABLE" },
        disclosed(done, "COMPLETED"),
        { status: "NON_ENFORCEABLE" },
      ]);
    });

    it("the refusal never names a retired prerequisite either: only the ones that block are listed", async () => {
      const w = await prerequisiteWorld();
      const [live, draft] = await Promise.all([w.make(), w.make()]);
      await w.requires(w.course.id, live.id);
      await w.requires(w.course.id, draft.id);
      await w.unpublish(draft.id);

      const err = await thrown(check(w));

      expect(err.prerequisites).toEqual([
        { courseId: live.id, slug: live.slug, title: live.title },
      ]);
      expect(JSON.stringify(err.prerequisites)).not.toContain(draft.slug);
    });
  });

  it("is empty for a course with no prerequisites", async () => {
    const w = await prerequisiteWorld();

    expect(await statuses(w)).toEqual([]);
  });

  it("completion outranks retirement: a completed prerequisite is COMPLETED whether or not it still binds", async () => {
    const w = await prerequisiteWorld();
    const [archived, draft, lessonless] = await Promise.all([w.make(), w.make(), w.make()]);
    for (const p of [archived, draft, lessonless]) {
      await w.requires(w.course.id, p.id);
      await w.complete(w.learner.user.id, p.id);
    }
    await w.archive(archived.id);
    await w.unpublish(draft.id);
    await w.removeLessons(lessonless.id);

    expect((await statuses(w)).map((s) => s.status)).toEqual([
      "COMPLETED",
      "COMPLETED",
      "COMPLETED",
    ]);
  });

  it("uses only the learner's own enrollment: learner A cannot see learner B's completion", async () => {
    const w = await prerequisiteWorld();
    const a = await w.make();
    await w.requires(w.course.id, a.id);
    const other = await createUserIn(w.tenant.id, "STUDENT");
    await w.complete(other.user.id, a.id);

    expect((await statuses(w, other.user.id)).map((s) => s.status)).toEqual(["COMPLETED"]);
    expect((await statuses(w)).map((s) => s.status)).toEqual(["REQUIRED"]);
  });

  it("returns exactly four fields and nothing about anyone else", async () => {
    const w = await prerequisiteWorld();
    const a = await w.make();
    await w.requires(w.course.id, a.id);
    const other = await createUserIn(w.tenant.id, "STUDENT");
    await w.complete(other.user.id, a.id);

    const [only] = await statuses(w);

    expect(Object.keys(only).sort()).toEqual(["courseId", "slug", "status", "title"]);
    expect(JSON.stringify(only)).not.toContain(other.user.id);
    expect(JSON.stringify(only)).not.toContain(w.tenant.id);
  });

  it("has nothing for a learner of another tenant, a learner with no tenant, or an unknown course or user", async () => {
    const w = await prerequisiteWorld();
    const a = await w.make();
    await w.requires(w.course.id, a.id);
    const foreign = await createScenario();
    const tenantless = await db.user.create({
      data: {
        clerkId: `t-${Math.random()}`,
        email: `t-${Math.random()}@example.test`,
        role: "STUDENT",
      },
    });

    expect(await statuses(w, foreign.learner.user.id)).toEqual([]);
    expect(await statuses(w, tenantless.id)).toEqual([]);
    expect(
      await getLearnerPrerequisiteStatuses(db, { userId: w.learner.user.id, courseId: "nope" })
    ).toEqual([]);
    expect(
      await getLearnerPrerequisiteStatuses(db, { userId: "nope", courseId: w.course.id })
    ).toEqual([]);
    expect(await check(w).catch((e) => e)).toBeInstanceOf(PrerequisitesNotMetError);
  });

  it("never returns a prerequisite of another tenant, even one forced into the table, and it does not block", async () => {
    const w = await prerequisiteWorld();
    const foreign = await prerequisiteWorld();
    await w.requires(w.course.id, foreign.course.id);

    expect(await statuses(w)).toEqual([]);
    expect(await check(w)).toEqual([]);
  });

  it("asking about another tenant's course returns nothing, even if that course was forced to require one of the learner's own", async () => {
    const w = await prerequisiteWorld();
    const foreign = await prerequisiteWorld();
    const mine = await w.make();
    await foreign.requires(foreign.course.id, mine.id);

    expect(
      await getLearnerPrerequisiteStatuses(db, {
        userId: w.learner.user.id,
        courseId: foreign.course.id,
      })
    ).toEqual([]);
    expect(
      await assertCoursePrerequisitesMet(db, {
        userId: w.learner.user.id,
        courseId: foreign.course.id,
      })
    ).toEqual([]);
  });

  it("never returns an open-catalogue (tenantless) prerequisite", async () => {
    const w = await prerequisiteWorld();
    const tenantless = await db.course.create({
      data: {
        title: "open",
        slug: `open-${Math.random()}`,
        instructorId: w.instructor.user.id,
        tenantId: null,
        status: "PUBLISHED",
      },
    });
    await w.requires(w.course.id, tenantless.id);

    expect(await statuses(w)).toEqual([]);
  });

  it("agrees with getUnmetPrerequisites (Phase 29.1) about which are unmet, for every state", async () => {
    const w = await prerequisiteWorld();
    const [done, active, refunded, none, archived, draft, lessonless] = await Promise.all(
      Array.from({ length: 7 }, () => w.make())
    );
    for (const p of [done, active, refunded, none, archived, draft, lessonless]) {
      await w.requires(w.course.id, p.id);
    }
    await w.complete(w.learner.user.id, done.id);
    await w.enroll(w.learner.user.id, active.id, "ACTIVE");
    await w.enroll(w.learner.user.id, refunded.id, "REFUNDED");
    await w.archive(archived.id);
    await w.unpublish(draft.id);
    await w.removeLessons(lessonless.id);

    const required = (await statuses(w)).flatMap((s) =>
      s.status === "REQUIRED" ? [{ slug: s.slug, title: s.title }] : []
    );
    const unmet = await getUnmetPrerequisites(db, {
      userId: w.learner.user.id,
      courseId: w.course.id,
    });

    expect(unmet).toEqual(required);
    expect(required).toHaveLength(3);
  });
});

describe("query counts", () => {
  function spyReads() {
    return [
      vi.spyOn(db.user, "findUnique"),
      vi.spyOn(db.course, "findFirst"),
      vi.spyOn(db.coursePrerequisite, "findMany"),
      vi.spyOn(db.section, "findMany"),
      vi.spyOn(db.enrollment, "findMany"),
    ];
  }

  async function measure(n: number, run: (w: World) => Promise<unknown>) {
    const w = await prerequisiteWorld();
    for (let i = 0; i < n; i++) await w.requires(w.course.id, (await w.make()).id);
    const spies = spyReads();
    await run(w).catch(() => undefined);
    const calls = spies.map((s) => s.mock.calls.length);
    vi.restoreAllMocks();
    return calls;
  }

  it("the learner status read issues the same five queries for 1 as for 5 prerequisites", async () => {
    expect(await measure(1, statuses)).toEqual(await measure(5, statuses));
    expect(await measure(5, statuses)).toEqual([1, 1, 1, 1, 1]);
  });

  it("the gate costs the same five queries, pass or fail, however many prerequisites", async () => {
    expect(await measure(1, check)).toEqual(await measure(5, check));
    expect(await measure(5, check)).toEqual([1, 1, 1, 1, 1]);
  });

  it("a course with no prerequisites costs three queries and no lesson or enrollment lookup", async () => {
    expect(await measure(0, check)).toEqual([1, 1, 1, 0, 0]);
  });
});
