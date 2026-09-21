import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  assertCoursePrerequisitesMet,
  getLearnerPrerequisiteStatuses,
  getPrerequisiteStandings,
  getUnmetPrerequisites,
  PrerequisitesNotMetError,
} from "@/lib/domain/course/prerequisites";
import { type LearnerWorld, learnerWorld } from "@/lib/domain/learner-path/__test__/learnerWorld";
import { getLearningPathForLearner } from "@/lib/domain/learner-path/learnerPaths";

afterAll(async () => {
  await db.$disconnect();
});

/** A path holding one target course, and how the target reads for the learner. */
async function stateOf(w: LearnerWorld, target: { id: string }) {
  const path = await w.publishedPath([target]);
  const [course] = (await getLearningPathForLearner(w.learner.ctx, path.id)).courses;
  return { prerequisiteState: course?.prerequisiteState, availability: course?.availability };
}

async function target(w: LearnerWorld, prerequisites: { id: string }[]) {
  const course = await w.make();
  for (const p of prerequisites) await w.requires(course.id, p.id);
  return course;
}

describe("prerequisiteState: NONE", () => {
  it("no edges", async () => {
    const w = await learnerWorld();

    expect(await stateOf(w, await target(w, []))).toEqual({
      prerequisiteState: "NONE",
      availability: "AVAILABLE",
    });
  });

  it.each([
    ["a draft", async (w: LearnerWorld) => w.make({ status: "DRAFT" })],
    ["an archived", async (w: LearnerWorld) => w.make({ status: "ARCHIVED" })],
    ["a lessonless", async (w: LearnerWorld) => w.make({ lessons: false })],
  ])(
    "only a retired prerequisite (%s course, not completed): it does not block",
    async (_n, build) => {
      const w = await learnerWorld();

      expect(await stateOf(w, await target(w, [await build(w)]))).toEqual({
        prerequisiteState: "NONE",
        availability: "AVAILABLE",
      });
    }
  );

  it("a prerequisite completed and later archived, alone: it no longer binds, so NONE, and never blocks", async () => {
    const w = await learnerWorld();
    const p = await w.make();
    await w.complete(p.id);
    await w.archive(p.id);

    expect(await stateOf(w, await target(w, [p]))).toEqual({
      prerequisiteState: "NONE",
      availability: "AVAILABLE",
    });
  });
});

describe("prerequisiteState: MET", () => {
  it("one enforceable prerequisite completed", async () => {
    const w = await learnerWorld();
    const p = await w.make();
    await w.complete(p.id);

    expect(await stateOf(w, await target(w, [p]))).toEqual({
      prerequisiteState: "MET",
      availability: "AVAILABLE",
    });
  });

  it("several enforceable prerequisites, all completed", async () => {
    const w = await learnerWorld();
    const ps = await w.makeMany(3);
    for (const p of ps) await w.complete(p.id);

    expect((await stateOf(w, await target(w, ps))).prerequisiteState).toBe("MET");
  });

  it("a completed prerequisite that was later archived or emptied still counts beside a live completed one", async () => {
    const w = await learnerWorld();
    const [live, archived, bare] = await w.makeMany(3);
    if (!live || !archived || !bare) throw new Error("fixture");
    for (const p of [live, archived, bare]) await w.complete(p.id);
    await w.archive(archived.id);
    await w.removeLessons(bare.id);

    expect(await stateOf(w, await target(w, [live, archived, bare]))).toEqual({
      prerequisiteState: "MET",
      availability: "AVAILABLE",
    });
  });

  it("mixed: an enforceable completed prerequisite and a retired incomplete one", async () => {
    const w = await learnerWorld();
    const done = await w.make();
    const retired = await w.make({ status: "ARCHIVED" });
    await w.complete(done.id);

    expect((await stateOf(w, await target(w, [done, retired]))).prerequisiteState).toBe("MET");
  });
});

describe("prerequisiteState: UNMET", () => {
  it("one enforceable prerequisite not completed", async () => {
    const w = await learnerWorld();
    const p = await w.make();

    expect(await stateOf(w, await target(w, [p]))).toEqual({
      prerequisiteState: "UNMET",
      availability: "UNAVAILABLE",
    });
  });

  it("several prerequisites with one incomplete", async () => {
    const w = await learnerWorld();
    const [a, b, c] = await w.makeMany(3);
    if (!a || !b || !c) throw new Error("fixture");
    await w.complete(a.id);
    await w.complete(b.id);

    expect((await stateOf(w, await target(w, [a, b, c]))).prerequisiteState).toBe("UNMET");
  });

  it.each([["ACTIVE"], ["REFUNDED"]] as const)(
    "an %s enrollment does not satisfy",
    async (status) => {
      const w = await learnerWorld();
      const p = await w.make();
      await w.enroll(w.learner.user.id, p.id, status);

      expect((await stateOf(w, await target(w, [p]))).prerequisiteState).toBe("UNMET");
    }
  );

  it("another learner's completion does not satisfy this learner's prerequisite", async () => {
    const w = await learnerWorld();
    const p = await w.make();
    const other = await w.otherLearner();
    await w.complete(p.id, other.user.id);

    expect((await stateOf(w, await target(w, [p]))).prerequisiteState).toBe("UNMET");
  });

  it("is UNMET whichever order the edges were made in: an incomplete prerequisite first, a completed one after", async () => {
    const w = await learnerWorld();
    const open = await w.make();
    const done = await w.make();
    await w.complete(done.id);
    const course = await w.make();
    await w.requires(course.id, open.id);
    await w.requires(course.id, done.id);

    expect((await stateOf(w, course)).prerequisiteState).toBe("UNMET");
  });

  it("mixed: an enforceable completed prerequisite and an enforceable incomplete one", async () => {
    const w = await learnerWorld();
    const [done, open] = await w.makeMany(2);
    if (!done || !open) throw new Error("fixture");
    await w.complete(done.id);

    expect((await stateOf(w, await target(w, [done, open]))).prerequisiteState).toBe("UNMET");
  });

  it("a prerequisite edge to another tenant's course is ignored, as the enrollment gate ignores it", async () => {
    const w = await learnerWorld();
    const foreign = await w.makeForeign();
    const course = await target(w, []);
    await w.requires(course.id, foreign.id);

    expect((await stateOf(w, course)).prerequisiteState).toBe("NONE");
  });
});

describe("parity with the enrollment prerequisite gate", () => {
  it("agrees with getUnmetPrerequisites, assertCoursePrerequisitesMet and getLearnerPrerequisiteStatuses for every combination of prerequisite kinds", async () => {
    const w = await learnerWorld();
    const learner = w.learner.user.id;
    const other = await w.otherLearner();

    const kinds = {
      liveCompleted: async () => {
        const p = await w.make();
        await w.complete(p.id);
        return p;
      },
      liveOpen: async () => w.make(),
      retiredOpen: async () => w.make({ status: "ARCHIVED" }),
      completedThenArchived: async () => {
        const p = await w.make();
        await w.complete(p.id);
        await w.archive(p.id);
        return p;
      },
      active: async () => {
        const p = await w.make();
        await w.enroll(learner, p.id, "ACTIVE");
        return p;
      },
      refunded: async () => {
        const p = await w.make();
        await w.enroll(learner, p.id, "REFUNDED");
        return p;
      },
      othersCompletion: async () => {
        const p = await w.make();
        await w.complete(p.id, other.user.id);
        return p;
      },
    };
    const names = Object.keys(kinds) as (keyof typeof kinds)[];
    const prerequisites = Object.fromEntries(
      await Promise.all(names.map(async (n) => [n, await kinds[n]()] as const))
    );

    const targets: { id: string; picked: string[] }[] = [];
    for (let mask = 1; mask < 1 << names.length; mask++) {
      const picked = names.filter((_, i) => mask & (1 << i));
      const course = await w.make();
      for (const n of picked) {
        const p = prerequisites[n];
        if (p) await w.requires(course.id, p.id);
      }
      targets.push({ id: course.id, picked });
    }

    const batched = await getPrerequisiteStandings(db, {
      userId: learner,
      tenantId: w.tenant.id,
      courseIds: targets.map((t) => t.id),
    });

    const seen = new Set<string>();
    for (const { id, picked } of targets) {
      const standing = batched.get(id);
      seen.add(standing ?? "missing");
      const unmet = await getUnmetPrerequisites(db, { userId: learner, courseId: id });
      const statuses = await getLearnerPrerequisiteStatuses(db, { userId: learner, courseId: id });
      const gate = await assertCoursePrerequisitesMet(db, { userId: learner, courseId: id }).then(
        () => "PASSES",
        (err) => (err instanceof PrerequisitesNotMetError ? "REFUSES" : `UNEXPECTED ${err}`)
      );
      const label = picked.join("+");

      expect(standing === "UNMET", label).toBe(unmet.length > 0);
      expect(gate, label).toBe(standing === "UNMET" ? "REFUSES" : "PASSES");
      expect(
        statuses.some((s) => s.status === "REQUIRED"),
        label
      ).toBe(standing === "UNMET");
      if (standing === "MET") {
        expect(
          statuses.some((s) => s.status === "COMPLETED"),
          label
        ).toBe(true);
      }
      if (standing === "NONE") {
        expect(
          statuses.some((s) => s.status === "REQUIRED"),
          label
        ).toBe(false);
      }
    }
    expect([...seen].sort()).toEqual(["MET", "NONE", "UNMET"]);
  }, 120_000);

  it("the path read reports the same state the batched evaluator does", async () => {
    const w = await learnerWorld();
    const [done, open, retired] = await Promise.all([
      w.make(),
      w.make(),
      w.make({ status: "ARCHIVED" }),
    ]);
    await w.complete(done.id);
    const none = await target(w, [retired]);
    const met = await target(w, [done, retired]);
    const unmet = await target(w, [done, open]);
    const path = await w.publishedPath([none, met, unmet]);

    const read = await getLearningPathForLearner(w.learner.ctx, path.id);
    const standings = await getPrerequisiteStandings(db, {
      userId: w.learner.user.id,
      tenantId: w.tenant.id,
      courseIds: [none.id, met.id, unmet.id],
    });

    expect(read.courses.map((c) => c.prerequisiteState)).toEqual(["NONE", "MET", "UNMET"]);
    expect([none.id, met.id, unmet.id].map((id) => standings.get(id))).toEqual([
      "NONE",
      "MET",
      "UNMET",
    ]);
  });

  it("MET or NONE means the enrollment gate lets the learner in; UNMET means it refuses", async () => {
    const w = await learnerWorld();
    const [done, open] = await w.makeMany(2);
    if (!done || !open) throw new Error("fixture");
    await w.complete(done.id);
    const ok = await target(w, [done]);
    const blocked = await target(w, [done, open]);

    expect((await stateOf(w, ok)).prerequisiteState).toBe("MET");
    await expect(
      assertCoursePrerequisitesMet(db, { userId: w.learner.user.id, courseId: ok.id })
    ).resolves.toBeDefined();
    expect((await stateOf(w, blocked)).prerequisiteState).toBe("UNMET");
    await expect(
      assertCoursePrerequisitesMet(db, { userId: w.learner.user.id, courseId: blocked.id })
    ).rejects.toBeInstanceOf(PrerequisitesNotMetError);
  });
});

describe("getPrerequisiteStandings", () => {
  it("answers every id it is given, NONE for a course with nothing to enforce, and nothing for an empty list", async () => {
    const w = await learnerWorld();
    const c = await w.make();

    const out = await getPrerequisiteStandings(db, {
      userId: w.learner.user.id,
      tenantId: w.tenant.id,
      courseIds: [c.id, "unknown-id"],
    });

    expect([...out.entries()]).toEqual([
      [c.id, "NONE"],
      ["unknown-id", "NONE"],
    ]);
    expect(
      (
        await getPrerequisiteStandings(db, {
          userId: w.learner.user.id,
          tenantId: w.tenant.id,
          courseIds: [],
        })
      ).size
    ).toBe(0);
  });

  it("a course outside the learner's tenant has no prerequisites to enforce", async () => {
    const w = await learnerWorld();
    const other = await learnerWorld();
    const p = await other.make();
    const c = await other.make();
    await other.requires(c.id, p.id);

    const out = await getPrerequisiteStandings(db, {
      userId: w.learner.user.id,
      tenantId: w.tenant.id,
      courseIds: [c.id],
    });

    expect(out.get(c.id)).toBe("NONE");
  });

  it("a course outside the learner's tenant has no prerequisites to enforce, even one with an edge to a prerequisite of the learner's own tenant", async () => {
    const w = await learnerWorld();
    const other = await learnerWorld();
    const mine = await w.make();
    const theirs = await other.make();
    await other.requires(theirs.id, mine.id);

    const out = await getPrerequisiteStandings(db, {
      userId: w.learner.user.id,
      tenantId: w.tenant.id,
      courseIds: [theirs.id],
    });

    expect(out.get(theirs.id)).toBe("NONE");
    expect(
      await getUnmetPrerequisites(db, { userId: w.learner.user.id, courseId: theirs.id })
    ).toEqual([]);
  });

  it("is three queries however many courses, and none of them writes", async () => {
    const w = await learnerWorld();
    const shared = await w.make();
    const courses = await w.makeMany(12);
    for (const c of courses) await w.requires(c.id, shared.id);

    const { vi } = await import("vitest");
    const spies = [
      vi.spyOn(db.coursePrerequisite, "findMany"),
      vi.spyOn(db.section, "findMany"),
      vi.spyOn(db.enrollment, "findMany"),
    ];
    await getPrerequisiteStandings(db, {
      userId: w.learner.user.id,
      tenantId: w.tenant.id,
      courseIds: courses.map((c) => c.id),
    });
    const calls = spies.map((s) => s.mock.calls.length);
    vi.restoreAllMocks();

    expect(calls).toEqual([1, 1, 1]);
  });
});
