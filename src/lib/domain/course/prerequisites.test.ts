import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  addCoursePrerequisite,
  CoursePrerequisiteError,
  type CoursePrerequisiteErrorCode,
  getUnmetPrerequisites,
  isEnforceablePrerequisite,
  listCoursePrerequisites,
  MAX_PREREQUISITES_PER_COURSE,
  removeCoursePrerequisite,
  wouldCloseCycle,
} from "@/lib/domain/course/prerequisites";
import {
  createCourseIn,
  createScenario,
  createUserIn,
} from "@/lib/domain/learning-assignment/__test__/fixtures";

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Scenario = Awaited<ReturnType<typeof createScenario>>;

/** A tenant with an admin, an instructor who owns every course made here, and a learner. */
async function world() {
  const s = await createScenario();
  const make = async (overrides: { status?: "DRAFT" | "PUBLISHED" | "ARCHIVED" } = {}) =>
    (await createCourseIn(s.tenant.id, s.instructor.user.id, overrides)).course;
  return { ...s, make };
}

const add = (ctx: Scenario["admin"]["ctx"], courseId: string, prerequisiteCourseId: string) =>
  addCoursePrerequisite(ctx, { courseId, prerequisiteCourseId });

/** The error code, or "OK" when the call succeeded. */
async function outcome(promise: Promise<unknown>): Promise<CoursePrerequisiteErrorCode | "OK"> {
  try {
    await promise;
    return "OK";
  } catch (err) {
    if (err instanceof CoursePrerequisiteError) return err.code;
    throw err;
  }
}

async function failure(promise: Promise<unknown>): Promise<CoursePrerequisiteError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof CoursePrerequisiteError) return err;
    throw err;
  }
  throw new Error("expected the call to fail");
}

const edgeRows = (tenantId: string) =>
  db.coursePrerequisite.findMany({ where: { course: { tenantId } } });

function hasCycle(edges: { courseId: string; prerequisiteCourseId: string }[]): boolean {
  return edges.some((e, i) =>
    wouldCloseCycle([...edges.slice(0, i), ...edges.slice(i + 1)], {
      courseId: e.courseId,
      prerequisiteCourseId: e.prerequisiteCourseId,
    })
  );
}

type Tx = { coursePrerequisite: { findMany: (...a: unknown[]) => Promise<unknown> } };

/**
 * Hooks inside the interactive transaction of a prerequisite write: `afterGraphRead`
 * runs once the tenant's graph has been read, `beforeCreate` just before the insert.
 * A barrier placed in `afterGraphRead` is where two unsynchronized writers would each
 * be holding a graph that lacks the other's edge.
 */
function interceptTransactions(hooks: {
  afterGraphRead?: () => Promise<void>;
  beforeCreate?: (data: unknown) => Promise<void>;
  onGraphRead?: () => void;
}) {
  const real = db.$transaction.bind(db) as unknown as (
    fn: (tx: Tx) => Promise<unknown>,
    options?: unknown
  ) => Promise<unknown>;
  return vi.spyOn(db, "$transaction").mockImplementation(((
    fn: (tx: Tx) => Promise<unknown>,
    options?: unknown
  ) =>
    real(
      (tx) =>
        fn(
          new Proxy(tx, {
            get(target, prop, receiver) {
              const value = Reflect.get(target, prop, receiver);
              if (prop !== "coursePrerequisite") return value;
              return new Proxy(value as Tx["coursePrerequisite"], {
                get(delegate, method, delegateReceiver) {
                  if (method === "findMany") {
                    return async (...args: unknown[]) => {
                      const result = await delegate.findMany(...args);
                      hooks.onGraphRead?.();
                      await hooks.afterGraphRead?.();
                      return result;
                    };
                  }
                  if (method === "create") {
                    return async (args: { data: unknown }) => {
                      await hooks.beforeCreate?.(args.data);
                      return (
                        delegate as unknown as { create: (a: unknown) => Promise<unknown> }
                      ).create(args);
                    };
                  }
                  return Reflect.get(delegate, method, delegateReceiver);
                },
              });
            },
          })
        ),
      options
    )) as never);
}

/** Every party waits here (up to `timeoutMs`) for the others to have read the graph. */
function barrier(parties: number, timeoutMs = 400) {
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived >= parties) open();
    await Promise.race([gate, sleep(timeoutMs)]);
  };
}

/** Holds the tenant row lock in another transaction until released. */
async function holdTenantLock(tenantId: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked!: () => void;
  const lockedPromise = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const done = db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR UPDATE`;
      locked();
      await gate;
    },
    { timeout: 15_000 }
  );
  await lockedPromise;
  return async () => {
    release();
    await done;
  };
}

async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true
    ),
    sleep(ms).then(() => false),
  ]);
}

// ---------------------------------------------------------------------------
// Adding
// ---------------------------------------------------------------------------

describe("addCoursePrerequisite — creating an edge", () => {
  it("creates 'B requires A' and returns the edge without any tenant or title", async () => {
    const w = await world();
    const a = await w.make();

    const edge = await add(w.admin.ctx, w.course.id, a.id);

    expect(edge).toEqual({
      id: expect.any(String),
      courseId: w.course.id,
      prerequisiteCourseId: a.id,
      createdAt: expect.any(Date),
    });
    const stored = await db.coursePrerequisite.findUniqueOrThrow({ where: { id: edge.id } });
    expect(stored.courseId).toBe(w.course.id);
    expect(stored.prerequisiteCourseId).toBe(a.id);
  });

  it("records the acting user as creator and ignores a supplied creator or tenant", async () => {
    const w = await world();
    const a = await w.make();
    const other = await createUserIn(w.tenant.id, "ORG_ADMIN");

    const edge = await addCoursePrerequisite(w.admin.ctx, {
      courseId: w.course.id,
      prerequisiteCourseId: a.id,
      createdById: other.user.id,
      tenantId: "some-other-tenant",
    } as never);

    const stored = await db.coursePrerequisite.findUniqueOrThrow({ where: { id: edge.id } });
    expect(stored.createdById).toBe(w.admin.user.id);
  });

  it("keeps the edge when the creator's account is later removed (creator becomes null)", async () => {
    const w = await world();
    const a = await w.make();
    const extra = await createUserIn(w.tenant.id, "ORG_ADMIN");
    const edge = await add(extra.ctx, w.course.id, a.id);

    await db.user.delete({ where: { id: extra.user.id } });

    const stored = await db.coursePrerequisite.findUniqueOrThrow({ where: { id: edge.id } });
    expect(stored.createdById).toBeNull();
  });

  it("rejects a duplicate edge with a typed error and leaves one row", async () => {
    const w = await world();
    const a = await w.make();
    await add(w.admin.ctx, w.course.id, a.id);

    const err = await failure(add(w.admin.ctx, w.course.id, a.id));

    expect(err).toMatchObject({ status: 409, code: "DUPLICATE" });
    expect(await db.coursePrerequisite.count({ where: { courseId: w.course.id } })).toBe(1);
  });

  it("'A requires B' and 'B requires A' are different edges, and the second is the cycle", async () => {
    const w = await world();
    const b = await w.make();
    await add(w.admin.ctx, w.course.id, b.id);

    expect(await outcome(add(w.admin.ctx, b.id, w.course.id))).toBe("CYCLE");
  });

  it("rejects a self-edge before any graph work, and writes nothing", async () => {
    const w = await world();
    const graphReads = vi.fn();
    interceptTransactions({ onGraphRead: graphReads });

    const err = await failure(add(w.admin.ctx, w.course.id, w.course.id));

    expect(err).toMatchObject({ status: 409, code: "SELF_REFERENCE" });
    expect(graphReads).not.toHaveBeenCalled();
    expect(await edgeRows(w.tenant.id)).toEqual([]);
  });

  it.each([
    [{ courseId: "", prerequisiteCourseId: "x" }],
    [{ courseId: "x", prerequisiteCourseId: "" }],
    [{ courseId: "a b", prerequisiteCourseId: "x" }],
    [{ courseId: 7, prerequisiteCourseId: "x" }],
    [{ courseId: "x", prerequisiteCourseId: { $ne: "" } }],
    [null],
    [undefined],
  ])("rejects malformed input %j as invalid, not as a database error", async (input) => {
    const w = await world();

    const err = await failure(addCoursePrerequisite(w.admin.ctx, input as never));

    expect(err).toMatchObject({ status: 400, code: "INVALID_INPUT" });
  });
});

describe("addCoursePrerequisite — cycles", () => {
  it("rejects a three-course cycle", async () => {
    const w = await world();
    const b = await w.make();
    const c = await w.make();
    await add(w.admin.ctx, w.course.id, b.id); // A requires B
    await add(w.admin.ctx, b.id, c.id); // B requires C

    expect(await outcome(add(w.admin.ctx, c.id, w.course.id))).toBe("CYCLE"); // C requires A
  });

  it("rejects a four-course cycle", async () => {
    const w = await world();
    const [b, c, d] = await Promise.all([w.make(), w.make(), w.make()]);
    await add(w.admin.ctx, w.course.id, b.id); // A requires B
    await add(w.admin.ctx, b.id, c.id); // B requires C
    await add(w.admin.ctx, c.id, d.id); // C requires D

    expect(await outcome(add(w.admin.ctx, d.id, w.course.id))).toBe("CYCLE"); // D requires A
    expect(await edgeRows(w.tenant.id)).toHaveLength(3);
  });

  it("rejects cycles along a ten-course chain, and accepts an edge that leads out of it", async () => {
    const w = await world();
    const chain = [w.course, ...(await Promise.all(Array.from({ length: 9 }, () => w.make())))];
    for (let i = 0; i < chain.length - 1; i++) {
      await add(w.admin.ctx, chain[i].id, chain[i + 1].id);
    }

    expect(await outcome(add(w.admin.ctx, chain[9].id, chain[0].id))).toBe("CYCLE");
    expect(await outcome(add(w.admin.ctx, chain[9].id, chain[1].id))).toBe("CYCLE");
    // Nothing loops back if the new edge leads out of the chain.
    const outside = await w.make();
    expect(await outcome(add(w.admin.ctx, chain[9].id, outside.id))).toBe("OK");
  });

  it("allows a diamond: A>B, A>C, B>D, C>D", async () => {
    const w = await world();
    const [b, c, d] = await Promise.all([w.make(), w.make(), w.make()]);

    const results = [
      await outcome(add(w.admin.ctx, w.course.id, b.id)),
      await outcome(add(w.admin.ctx, w.course.id, c.id)),
      await outcome(add(w.admin.ctx, b.id, d.id)),
      await outcome(add(w.admin.ctx, c.id, d.id)),
    ];

    expect(results).toEqual(["OK", "OK", "OK", "OK"]);
    expect(hasCycle(await edgeRows(w.tenant.id))).toBe(false);
  });

  it("two courses may share a prerequisite without that being a cycle", async () => {
    const w = await world();
    const [b, shared] = await Promise.all([w.make(), w.make()]);

    expect(await outcome(add(w.admin.ctx, w.course.id, shared.id))).toBe("OK");
    expect(await outcome(add(w.admin.ctx, b.id, shared.id))).toBe("OK");
  });

  it("another tenant's graph never interferes", async () => {
    const one = await world();
    const two = await world();
    const [a1, a2] = [one.course, await one.make()];
    const [b1, b2] = [two.course, await two.make()];
    await add(one.admin.ctx, a1.id, a2.id);

    // The mirror-image edge in a different tenant is not a cycle there.
    expect(await outcome(add(two.admin.ctx, b2.id, b1.id))).toBe("OK");
    expect(await edgeRows(one.tenant.id)).toHaveLength(1);
  });

  describe("wouldCloseCycle (pure)", () => {
    const e = (courseId: string, prerequisiteCourseId: string) => ({
      courseId,
      prerequisiteCourseId,
    });

    it("finds cycles of any length and treats a self-edge as one", () => {
      expect(wouldCloseCycle([], e("a", "a"))).toBe(true);
      expect(wouldCloseCycle([e("a", "b")], e("b", "a"))).toBe(true);
      expect(wouldCloseCycle([e("a", "b"), e("b", "c"), e("c", "d")], e("d", "a"))).toBe(true);
    });

    it("does not confuse direction: a chain the other way round, and diamonds, are fine", () => {
      expect(wouldCloseCycle([e("a", "b"), e("b", "c")], e("a", "c"))).toBe(false);
      expect(wouldCloseCycle([e("a", "b")], e("c", "b"))).toBe(false);
      const diamond = [e("a", "b"), e("a", "c"), e("b", "d")];
      expect(wouldCloseCycle(diamond, e("c", "d"))).toBe(false);
    });

    it("terminates on an existing malformed cycle instead of looping", () => {
      const looped = [e("x", "y"), e("y", "x")];
      expect(wouldCloseCycle(looped, e("a", "x"))).toBe(false);
      expect(wouldCloseCycle(looped, e("y", "z"))).toBe(false);
    });
  });
});

describe("addCoursePrerequisite — maximum", () => {
  it("allows five prerequisites and rejects the sixth", async () => {
    const w = await world();
    const prerequisites = await Promise.all(Array.from({ length: 6 }, () => w.make()));
    for (const p of prerequisites.slice(0, 5)) await add(w.admin.ctx, w.course.id, p.id);

    const err = await failure(add(w.admin.ctx, w.course.id, prerequisites[5].id));

    expect(MAX_PREREQUISITES_PER_COURSE).toBe(5);
    expect(err).toMatchObject({ status: 409, code: "LIMIT_REACHED" });
    expect(await db.coursePrerequisite.count({ where: { courseId: w.course.id } })).toBe(5);
  });

  it("the limit is per dependent course: another course can still take five", async () => {
    const w = await world();
    const other = await w.make();
    const prerequisites = await Promise.all(Array.from({ length: 5 }, () => w.make()));
    for (const p of prerequisites) await add(w.admin.ctx, w.course.id, p.id);

    for (const p of prerequisites)
      expect(await outcome(add(w.admin.ctx, other.id, p.id))).toBe("OK");
  });

  it("a repeat of an existing edge at the limit is a duplicate, not 'limit reached'", async () => {
    const w = await world();
    const prerequisites = await Promise.all(Array.from({ length: 5 }, () => w.make()));
    for (const p of prerequisites) await add(w.admin.ctx, w.course.id, p.id);

    expect(await outcome(add(w.admin.ctx, w.course.id, prerequisites[0].id))).toBe("DUPLICATE");
  });

  it("removing one frees a slot", async () => {
    const w = await world();
    const prerequisites = await Promise.all(Array.from({ length: 6 }, () => w.make()));
    for (const p of prerequisites.slice(0, 5)) await add(w.admin.ctx, w.course.id, p.id);
    await removeCoursePrerequisite(w.admin.ctx, {
      courseId: w.course.id,
      prerequisiteCourseId: prerequisites[0].id,
    });

    expect(await outcome(add(w.admin.ctx, w.course.id, prerequisites[5].id))).toBe("OK");
  });
});

// ---------------------------------------------------------------------------
// Tenant rules
// ---------------------------------------------------------------------------

describe("addCoursePrerequisite — tenant rules", () => {
  it("same-tenant dependent and prerequisite succeed", async () => {
    const w = await world();
    const a = await w.make();

    expect(await outcome(add(w.admin.ctx, w.course.id, a.id))).toBe("OK");
  });

  it("a foreign prerequisite is rejected exactly like an unknown one", async () => {
    const w = await world();
    const foreign = await world();

    const foreignErr = await failure(add(w.admin.ctx, w.course.id, foreign.course.id));
    const unknownErr = await failure(add(w.admin.ctx, w.course.id, "does-not-exist"));

    expect(foreignErr).toMatchObject({
      status: 404,
      code: "NOT_FOUND",
      message: "Course not found",
    });
    expect(foreignErr.message).toBe(unknownErr.message);
    expect(foreignErr.status).toBe(unknownErr.status);
    expect(await edgeRows(w.tenant.id)).toEqual([]);
  });

  it("a foreign dependent is rejected exactly like an unknown one", async () => {
    const w = await world();
    const foreign = await world();

    const foreignErr = await failure(add(w.admin.ctx, foreign.course.id, w.course.id));
    const unknownErr = await failure(add(w.admin.ctx, "does-not-exist", w.course.id));

    expect(foreignErr).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(foreignErr.message).toBe(unknownErr.message);
    expect(await edgeRows(foreign.tenant.id)).toEqual([]);
  });

  it("a tenantless dependent is rejected", async () => {
    const w = await world();
    const a = await w.make();
    const tenantless = (await createCourseIn(null, w.instructor.user.id)).course;

    const err = await failure(add(w.admin.ctx, tenantless.id, a.id));

    expect(err).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await db.coursePrerequisite.count({ where: { courseId: tenantless.id } })).toBe(0);
  });

  it("a tenantless prerequisite is rejected", async () => {
    const w = await world();
    const tenantless = (await createCourseIn(null, w.instructor.user.id)).course;

    const err = await failure(add(w.admin.ctx, w.course.id, tenantless.id));

    expect(err).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await edgeRows(w.tenant.id)).toEqual([]);
  });

  it("a tenantless course is refused even to an instructor who owns it (a solo instructor)", async () => {
    const solo = await db.user.create({
      data: {
        clerkId: `solo-${Date.now()}-${Math.random()}`,
        email: `solo-${Math.random()}@example.test`,
        role: "INSTRUCTOR",
      },
    });
    const mine = (await createCourseIn(null, solo.id)).course;
    const other = (await createCourseIn(null, solo.id)).course;
    const soloCtx = {
      userId: solo.id,
      clerkId: solo.clerkId,
      tenantId: null,
      role: "INSTRUCTOR" as const,
    };

    expect(
      await outcome(
        addCoursePrerequisite(soloCtx, { courseId: mine.id, prerequisiteCourseId: other.id })
      )
    ).toBe("NOT_FOUND");
  });

  it("an admin with no tenant sees no course at all", async () => {
    const w = await world();
    const a = await w.make();
    const noTenantAdmin = {
      ...w.admin.ctx,
      tenantId: null,
    } as unknown as Scenario["admin"]["ctx"];

    expect(await outcome(add(noTenantAdmin, w.course.id, a.id))).toBe("NOT_FOUND");
  });

  it("a course of another tenant is not returned as an edge even if one is forced into the table", async () => {
    const w = await world();
    const foreign = await world();
    await db.coursePrerequisite.create({
      data: { courseId: w.course.id, prerequisiteCourseId: foreign.course.id },
    });

    expect(await listCoursePrerequisites(w.admin.ctx, w.course.id)).toEqual([]);
    expect(
      await getUnmetPrerequisites(db, { userId: w.learner.user.id, courseId: w.course.id })
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Course lifecycle
// ---------------------------------------------------------------------------

describe("addCoursePrerequisite — course state", () => {
  it("accepts DRAFT and PUBLISHED courses on either side", async () => {
    const w = await world();
    const draft = await w.make({ status: "DRAFT" });
    const published = await w.make({ status: "PUBLISHED" });
    const draftDependent = await w.make({ status: "DRAFT" });

    expect(await outcome(add(w.admin.ctx, w.course.id, draft.id))).toBe("OK");
    expect(await outcome(add(w.admin.ctx, w.course.id, published.id))).toBe("OK");
    expect(await outcome(add(w.admin.ctx, draftDependent.id, published.id))).toBe("OK");
  });

  it("rejects an archived prerequisite and an archived dependent for a NEW edge", async () => {
    const w = await world();
    const archived = await w.make({ status: "ARCHIVED" });

    const asPrerequisite = await failure(add(w.admin.ctx, w.course.id, archived.id));
    const asDependent = await failure(add(w.admin.ctx, archived.id, w.course.id));

    expect(asPrerequisite).toMatchObject({ status: 409, code: "COURSE_ARCHIVED" });
    expect(asDependent).toMatchObject({ status: 409, code: "COURSE_ARCHIVED" });
    expect(await edgeRows(w.tenant.id)).toEqual([]);
  });

  it("an existing edge survives either course being archived, and can still be removed", async () => {
    const w = await world();
    const a = await w.make();
    const b = await w.make();
    await add(w.admin.ctx, w.course.id, a.id);
    await add(w.admin.ctx, b.id, w.course.id);

    await db.course.update({ where: { id: a.id }, data: { status: "ARCHIVED" } });
    await db.course.update({ where: { id: b.id }, data: { status: "ARCHIVED" } });

    expect(await edgeRows(w.tenant.id)).toHaveLength(2);
    const [listed] = await listCoursePrerequisites(w.admin.ctx, w.course.id);
    expect(listed).toMatchObject({ status: "ARCHIVED", enforceable: false });
    await removeCoursePrerequisite(w.admin.ctx, {
      courseId: b.id,
      prerequisiteCourseId: w.course.id,
    });
    expect(await edgeRows(w.tenant.id)).toHaveLength(1);
  });

  it("an archived course in the middle of a chain still takes part in cycle detection", async () => {
    const w = await world();
    const [b, c] = await Promise.all([w.make(), w.make()]);
    await add(w.admin.ctx, w.course.id, b.id); // A requires B
    await add(w.admin.ctx, b.id, c.id); // B requires C
    await db.course.update({ where: { id: b.id }, data: { status: "ARCHIVED" } });

    expect(await outcome(add(w.admin.ctx, c.id, w.course.id))).toBe("CYCLE"); // C requires A
  });
});

// ---------------------------------------------------------------------------
// Removing and reading
// ---------------------------------------------------------------------------

describe("removeCoursePrerequisite", () => {
  it("removes the matching edge and only that edge", async () => {
    const w = await world();
    const [a, b] = await Promise.all([w.make(), w.make()]);
    await add(w.admin.ctx, w.course.id, a.id);
    await add(w.admin.ctx, w.course.id, b.id);

    await removeCoursePrerequisite(w.admin.ctx, {
      courseId: w.course.id,
      prerequisiteCourseId: a.id,
    });

    const rows = await edgeRows(w.tenant.id);
    expect(rows.map((r) => r.prerequisiteCourseId)).toEqual([b.id]);
  });

  it("answers 404 for an edge that does not exist, and again for the same edge twice", async () => {
    const w = await world();
    const a = await w.make();
    await add(w.admin.ctx, w.course.id, a.id);
    await removeCoursePrerequisite(w.admin.ctx, {
      courseId: w.course.id,
      prerequisiteCourseId: a.id,
    });

    const again = await failure(
      removeCoursePrerequisite(w.admin.ctx, { courseId: w.course.id, prerequisiteCourseId: a.id })
    );
    const never = await failure(
      removeCoursePrerequisite(w.admin.ctx, { courseId: w.course.id, prerequisiteCourseId: "nope" })
    );

    expect(again).toMatchObject({
      status: 404,
      code: "NOT_FOUND",
      message: "Prerequisite not found",
    });
    expect(never.message).toBe(again.message);
  });

  it("cannot remove another tenant's edge, and answers as if it were not there", async () => {
    const w = await world();
    const foreign = await world();
    const fa = await foreign.make();
    await add(foreign.admin.ctx, foreign.course.id, fa.id);

    const err = await failure(
      removeCoursePrerequisite(w.admin.ctx, {
        courseId: foreign.course.id,
        prerequisiteCourseId: fa.id,
      })
    );

    expect(err).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await edgeRows(foreign.tenant.id)).toHaveLength(1);
  });

  it("an edge can be added again after it was removed", async () => {
    const w = await world();
    const a = await w.make();
    await add(w.admin.ctx, w.course.id, a.id);
    await removeCoursePrerequisite(w.admin.ctx, {
      courseId: w.course.id,
      prerequisiteCourseId: a.id,
    });

    expect(await outcome(add(w.admin.ctx, w.course.id, a.id))).toBe("OK");
  });

  it("removing an edge lets a cycle-forming edge be added afterwards", async () => {
    const w = await world();
    const b = await w.make();
    await add(w.admin.ctx, w.course.id, b.id);
    expect(await outcome(add(w.admin.ctx, b.id, w.course.id))).toBe("CYCLE");

    await removeCoursePrerequisite(w.admin.ctx, {
      courseId: w.course.id,
      prerequisiteCourseId: b.id,
    });

    expect(await outcome(add(w.admin.ctx, b.id, w.course.id))).toBe("OK");
  });
});

describe("listCoursePrerequisites", () => {
  it("lists a course's prerequisites in the order they were added, with what a screen needs", async () => {
    const w = await world();
    const a = await w.make();
    const b = await w.make({ status: "DRAFT" });
    await add(w.admin.ctx, w.course.id, a.id);
    await add(w.admin.ctx, w.course.id, b.id);

    const list = await listCoursePrerequisites(w.admin.ctx, w.course.id);

    expect(list).toEqual([
      {
        prerequisiteCourseId: a.id,
        slug: a.slug,
        title: a.title,
        status: "PUBLISHED",
        hasPublishedLessons: true,
        enforceable: true,
      },
      {
        prerequisiteCourseId: b.id,
        slug: b.slug,
        title: b.title,
        status: "DRAFT",
        hasPublishedLessons: true,
        enforceable: false,
      },
    ]);
  });

  it("is empty for a course with no prerequisites, and does no lesson lookup", async () => {
    const w = await world();
    const sections = vi.spyOn(db.section, "findMany");

    expect(await listCoursePrerequisites(w.admin.ctx, w.course.id)).toEqual([]);
    expect(sections).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Enforceability and satisfaction
// ---------------------------------------------------------------------------

async function withEdge(w: Awaited<ReturnType<typeof world>>, prerequisiteOverrides = {}) {
  const prerequisite = await w.make(prerequisiteOverrides);
  await add(w.admin.ctx, w.course.id, prerequisite.id);
  return prerequisite;
}

const unmet = (w: Awaited<ReturnType<typeof world>>, userId = w.learner.user.id) =>
  getUnmetPrerequisites(db, { userId, courseId: w.course.id });

describe("enforceability", () => {
  it("a published course with a published, non-archived lesson is enforceable, and unmet until completed", async () => {
    const w = await world();
    const a = await withEdge(w);

    expect(await unmet(w)).toEqual([{ slug: a.slug, title: a.title }]);
  });

  it("an archived prerequisite is not enforceable and not reported", async () => {
    const w = await world();
    const a = await withEdge(w);
    await db.course.update({ where: { id: a.id }, data: { status: "ARCHIVED" } });

    expect(await unmet(w)).toEqual([]);
  });

  it("a DRAFT prerequisite (unavailable to learners) is not enforceable", async () => {
    const w = await world();
    await withEdge(w, { status: "DRAFT" });

    expect(await unmet(w)).toEqual([]);
  });

  it.each([
    [
      "no lessons at all",
      async (courseId: string) => {
        await db.lesson.deleteMany({ where: { section: { courseId } } });
      },
    ],
    [
      "only an unpublished lesson",
      async (courseId: string) => {
        await db.lesson.updateMany({
          where: { section: { courseId } },
          data: { isPublished: false },
        });
      },
    ],
    [
      "only an archived lesson",
      async (courseId: string) => {
        await db.lesson.updateMany({
          where: { section: { courseId } },
          data: { isArchived: true },
        });
      },
    ],
  ])("a published course with %s is not enforceable and not reported", async (_name, strip) => {
    const w = await world();
    const a = await withEdge(w);
    await strip(a.id);

    expect(await unmet(w)).toEqual([]);
    expect(await listCoursePrerequisites(w.admin.ctx, w.course.id)).toMatchObject([
      { hasPublishedLessons: false, enforceable: false },
    ]);
  });

  it("a completed prerequisite that is later archived stays satisfied", async () => {
    const w = await world();
    const a = await withEdge(w);
    await db.enrollment.create({
      data: {
        userId: w.learner.user.id,
        courseId: a.id,
        status: "COMPLETED",
        completedAt: new Date(),
      },
    });
    await db.course.update({ where: { id: a.id }, data: { status: "ARCHIVED" } });

    expect(await unmet(w)).toEqual([]);
  });

  it("an incomplete retired prerequisite is not returned, while an incomplete enforceable one is", async () => {
    const w = await world();
    const retired = await withEdge(w);
    const live = await withEdge(w);
    await db.course.update({ where: { id: retired.id }, data: { status: "ARCHIVED" } });

    expect(await unmet(w)).toEqual([{ slug: live.slug, title: live.title }]);
  });

  it("matches the lesson test in the completion route exactly, for every lesson state", async () => {
    const w = await world();
    type Lessons = { isPublished: boolean; isArchived: boolean }[][];
    const cases: Lessons[] = [
      [],
      [[]],
      [[{ isPublished: true, isArchived: false }]],
      [[{ isPublished: false, isArchived: false }]],
      [[{ isPublished: true, isArchived: true }]],
      [[{ isPublished: false, isArchived: true }]],
      [
        [
          { isPublished: false, isArchived: false },
          { isPublished: true, isArchived: false },
        ],
      ],
      [[{ isPublished: true, isArchived: true }], [{ isPublished: true, isArchived: false }]],
      [[{ isPublished: false, isArchived: false }], [{ isPublished: true, isArchived: true }]],
    ];

    for (const sections of cases) {
      const course = (await createCourseIn(w.tenant.id, w.instructor.user.id)).course;
      await db.lesson.deleteMany({ where: { section: { courseId: course.id } } });
      await db.section.deleteMany({ where: { courseId: course.id } });
      let n = 0;
      for (const lessons of sections) {
        const section = await db.section.create({
          data: { title: "s", order: n++, courseId: course.id },
        });
        for (const l of lessons) {
          await db.lesson.create({
            data: {
              title: "l",
              slug: `l-${Math.random()}`,
              order: n++,
              sectionId: section.id,
              ...l,
            },
          });
        }
      }
      await add(w.admin.ctx, w.course.id, course.id);

      // The completion route's own query: `totalLessons > 0`.
      const routeSaysCompletable =
        (
          await db.lesson.findMany({
            where: { section: { courseId: course.id }, isPublished: true, isArchived: false },
            select: { id: true },
          })
        ).length > 0;
      const listed = (await listCoursePrerequisites(w.admin.ctx, w.course.id)).find(
        (p) => p.prerequisiteCourseId === course.id
      );

      expect(listed?.hasPublishedLessons, JSON.stringify(sections)).toBe(routeSaysCompletable);
      await removeCoursePrerequisite(w.admin.ctx, {
        courseId: w.course.id,
        prerequisiteCourseId: course.id,
      });
    }
  });

  it("isEnforceablePrerequisite is true only for a PUBLISHED course that can be completed", () => {
    expect(isEnforceablePrerequisite({ status: "PUBLISHED", hasPublishedLessons: true })).toBe(
      true
    );
    expect(isEnforceablePrerequisite({ status: "PUBLISHED", hasPublishedLessons: false })).toBe(
      false
    );
    expect(isEnforceablePrerequisite({ status: "DRAFT", hasPublishedLessons: true })).toBe(false);
    expect(isEnforceablePrerequisite({ status: "ARCHIVED", hasPublishedLessons: true })).toBe(
      false
    );
  });
});

describe("satisfaction: an Enrollment on the prerequisite that is COMPLETED", () => {
  it("COMPLETED is satisfied", async () => {
    const w = await world();
    const a = await withEdge(w);
    await db.enrollment.create({
      data: {
        userId: w.learner.user.id,
        courseId: a.id,
        status: "COMPLETED",
        completedAt: new Date(),
      },
    });

    expect(await unmet(w)).toEqual([]);
  });

  it.each(["ACTIVE", "REFUNDED"] as const)("%s is unmet", async (status) => {
    const w = await world();
    const a = await withEdge(w);
    await db.enrollment.create({ data: { userId: w.learner.user.id, courseId: a.id, status } });

    expect(await unmet(w)).toEqual([{ slug: a.slug, title: a.title }]);
  });

  it("not enrolled is unmet", async () => {
    const w = await world();
    const a = await withEdge(w);

    expect(await unmet(w)).toEqual([{ slug: a.slug, title: a.title }]);
  });

  it("is per learner: another learner's completion does not satisfy this one", async () => {
    const w = await world();
    const a = await withEdge(w);
    const other = await createUserIn(w.tenant.id, "STUDENT");
    await db.enrollment.create({
      data: { userId: other.user.id, courseId: a.id, status: "COMPLETED", completedAt: new Date() },
    });

    expect(await unmet(w, other.user.id)).toEqual([]);
    expect(await unmet(w)).toEqual([{ slug: a.slug, title: a.title }]);
  });

  it("all prerequisites must be completed (AND), and only the unmet ones come back", async () => {
    const w = await world();
    const a = await withEdge(w);
    const b = await withEdge(w);
    const c = await withEdge(w);
    await db.enrollment.create({
      data: {
        userId: w.learner.user.id,
        courseId: b.id,
        status: "COMPLETED",
        completedAt: new Date(),
      },
    });

    const result = await unmet(w);

    expect(result.map((r) => r.slug).sort()).toEqual([a.slug, c.slug].sort());
  });

  it("a course with no prerequisites has nothing unmet", async () => {
    const w = await world();

    expect(await unmet(w)).toEqual([]);
  });

  it("returns only slug and title, never an id", async () => {
    const w = await world();
    const a = await withEdge(w);

    const [only] = await unmet(w);

    expect(Object.keys(only).sort()).toEqual(["slug", "title"]);
    expect(JSON.stringify(only)).not.toContain(a.id);
  });

  it("has nothing to enforce for a learner with no tenant, another tenant's learner, or a course outside their tenant", async () => {
    const w = await world();
    await withEdge(w);
    const tenantless = await db.user.create({
      data: {
        clerkId: `t-${Math.random()}`,
        email: `t-${Math.random()}@example.test`,
        role: "STUDENT",
      },
    });
    const foreign = await createScenario();

    expect(await unmet(w, tenantless.id)).toEqual([]);
    expect(await unmet(w, foreign.learner.user.id)).toEqual([]);
    expect(
      await getUnmetPrerequisites(db, { userId: w.learner.user.id, courseId: "does-not-exist" })
    ).toEqual([]);
    expect(await getUnmetPrerequisites(db, { userId: "nope", courseId: w.course.id })).toEqual([]);
  });

  it("writes nothing: no enrollment, no notification, no edge change", async () => {
    const w = await world();
    await withEdge(w);
    const before = await Promise.all([
      db.enrollment.count(),
      db.notification.count(),
      db.coursePrerequisite.count(),
    ]);

    await unmet(w);

    expect(
      await Promise.all([
        db.enrollment.count(),
        db.notification.count(),
        db.coursePrerequisite.count(),
      ])
    ).toEqual(before);
  });

  it("works inside a transaction client too", async () => {
    const w = await world();
    const a = await withEdge(w);

    const inside = await db.$transaction((tx) =>
      getUnmetPrerequisites(tx, { userId: w.learner.user.id, courseId: w.course.id })
    );

    expect(inside).toEqual([{ slug: a.slug, title: a.title }]);
  });
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

describe("authorization", () => {
  it("ORG_ADMIN manages any course in their tenant, whoever owns it", async () => {
    const w = await world();
    const a = await w.make();

    expect(await outcome(add(w.admin.ctx, w.course.id, a.id))).toBe("OK");
    expect(await listCoursePrerequisites(w.admin.ctx, w.course.id)).toHaveLength(1);
    await removeCoursePrerequisite(w.admin.ctx, {
      courseId: w.course.id,
      prerequisiteCourseId: a.id,
    });
  });

  it("INSTRUCTOR manages the prerequisites of a course they own", async () => {
    const w = await world();
    const a = await w.make();

    expect(await outcome(add(w.instructor.ctx, w.course.id, a.id))).toBe("OK");
    expect(await listCoursePrerequisites(w.instructor.ctx, w.course.id)).toHaveLength(1);
    await removeCoursePrerequisite(w.instructor.ctx, {
      courseId: w.course.id,
      prerequisiteCourseId: a.id,
    });
    expect(await edgeRows(w.tenant.id)).toEqual([]);
  });

  it("INSTRUCTOR who owns the dependent course but not the prerequisite may still require it", async () => {
    const w = await world();
    const colleague = await createUserIn(w.tenant.id, "INSTRUCTOR");
    const theirs = (await createCourseIn(w.tenant.id, colleague.user.id)).course;

    expect(await outcome(add(w.instructor.ctx, w.course.id, theirs.id))).toBe("OK");
  });

  it("INSTRUCTOR who owns only the prerequisite cannot attach it to someone else's course", async () => {
    const w = await world();
    const colleague = await createUserIn(w.tenant.id, "INSTRUCTOR");
    const theirs = (await createCourseIn(w.tenant.id, colleague.user.id)).course;

    const err = await failure(add(colleague.ctx, w.course.id, theirs.id));

    expect(err).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(await edgeRows(w.tenant.id)).toEqual([]);
  });

  it("INSTRUCTOR who owns neither course is forbidden on add, remove and list", async () => {
    const w = await world();
    const colleague = await createUserIn(w.tenant.id, "INSTRUCTOR");
    const a = await w.make();
    await add(w.admin.ctx, w.course.id, a.id);

    expect(await outcome(add(colleague.ctx, w.course.id, a.id))).toBe("FORBIDDEN");
    expect(
      await outcome(
        removeCoursePrerequisite(colleague.ctx, {
          courseId: w.course.id,
          prerequisiteCourseId: a.id,
        })
      )
    ).toBe("FORBIDDEN");
    expect(await outcome(listCoursePrerequisites(colleague.ctx, w.course.id))).toBe("FORBIDDEN");
    expect(await edgeRows(w.tenant.id)).toHaveLength(1);
  });

  it.each(["STUDENT", "SUPER_ADMIN"] as const)("%s is forbidden everywhere", async (role) => {
    const w = await world();
    const a = await w.make();
    await add(w.admin.ctx, w.course.id, a.id);
    const actor = await createUserIn(w.tenant.id, role);

    expect(await outcome(add(actor.ctx, w.course.id, a.id))).toBe("FORBIDDEN");
    expect(
      await outcome(
        removeCoursePrerequisite(actor.ctx, { courseId: w.course.id, prerequisiteCourseId: a.id })
      )
    ).toBe("FORBIDDEN");
    expect(await outcome(listCoursePrerequisites(actor.ctx, w.course.id))).toBe("FORBIDDEN");
    expect(await edgeRows(w.tenant.id)).toHaveLength(1);
  });

  it("authorization is decided before the input is looked at: a student sending junk still gets 403", async () => {
    const w = await world();
    const student = await createUserIn(w.tenant.id, "STUDENT");

    const err = await failure(
      addCoursePrerequisite(student.ctx, { courseId: "", prerequisiteCourseId: "" })
    );

    expect(err.status).toBe(403);
  });

  it("another tenant's ORG_ADMIN and INSTRUCTOR get a 404, not a 403, so nothing is revealed", async () => {
    const w = await world();
    const a = await w.make();
    const foreign = await world();

    const admin = await failure(add(foreign.admin.ctx, w.course.id, a.id));
    const instructor = await failure(add(foreign.instructor.ctx, w.course.id, a.id));

    expect(admin).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(instructor).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await edgeRows(w.tenant.id)).toEqual([]);
  });

  it("an instructor in one tenant cannot use a course id of another tenant they do not own", async () => {
    const w = await world();
    const foreign = await world();

    const err = await failure(add(w.instructor.ctx, foreign.course.id, w.course.id));

    expect(err.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// The tenant lock
// ---------------------------------------------------------------------------

describe("the tenant row lock", () => {
  it("add waits for a holder of the tenant lock and proceeds when it is released", async () => {
    const w = await world();
    const a = await w.make();
    const release = await holdTenantLock(w.tenant.id);

    const pending = add(w.admin.ctx, w.course.id, a.id);
    const finishedWhileLocked = await settlesWithin(pending, 400);
    await release();

    expect(finishedWhileLocked).toBe(false);
    expect(await outcome(pending)).toBe("OK");
  });

  it("remove waits for the tenant lock too", async () => {
    const w = await world();
    const a = await w.make();
    await add(w.admin.ctx, w.course.id, a.id);
    const release = await holdTenantLock(w.tenant.id);

    const pending = removeCoursePrerequisite(w.admin.ctx, {
      courseId: w.course.id,
      prerequisiteCourseId: a.id,
    });
    const finishedWhileLocked = await settlesWithin(pending, 400);
    await release();

    expect(finishedWhileLocked).toBe(false);
    expect(await outcome(pending)).toBe("OK");
  });

  it("the lock is per tenant: another tenant's writes are not held up", async () => {
    const w = await world();
    const other = await world();
    const a = await other.make();
    const release = await holdTenantLock(w.tenant.id);

    const finished = await settlesWithin(add(other.admin.ctx, other.course.id, a.id), 2000);
    await release();

    expect(finished).toBe(true);
    expect(await edgeRows(other.tenant.id)).toHaveLength(1);
  });

  it("a request that fails a check still releases the lock", async () => {
    const w = await world();
    const b = await w.make();
    await add(w.admin.ctx, w.course.id, b.id);
    await outcome(add(w.admin.ctx, b.id, w.course.id));

    expect(await settlesWithin(add(w.admin.ctx, b.id, (await w.make()).id), 2000)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

describe("concurrent writes", () => {
  it("two simultaneous identical additions: one succeeds, one is a duplicate, one row exists", async () => {
    const w = await world();
    const a = await w.make();
    interceptTransactions({ afterGraphRead: barrier(2) });

    const results = await Promise.all([
      outcome(add(w.admin.ctx, w.course.id, a.id)),
      outcome(add(w.admin.ctx, w.course.id, a.id)),
    ]);

    expect(results.filter((r) => r === "OK")).toHaveLength(1);
    expect(results.filter((r) => r === "DUPLICATE")).toHaveLength(1);
    expect(await db.coursePrerequisite.count({ where: { courseId: w.course.id } })).toBe(1);
  });

  it("the unique index alone converges a duplicate that slipped past the check", async () => {
    const w = await world();
    const a = await w.make();
    // A writer that does not hold the lock inserts the same edge just before this one does.
    interceptTransactions({
      beforeCreate: async (data) => {
        await db.coursePrerequisite.create({ data: data as never });
      },
    });

    const err = await failure(add(w.admin.ctx, w.course.id, a.id));

    expect(err).toMatchObject({ status: 409, code: "DUPLICATE" });
    expect(await db.coursePrerequisite.count({ where: { courseId: w.course.id } })).toBe(1);
  });

  it("A>B and B>C exist; C>A (closes the cycle) races an unrelated edge: only the cycle is refused", async () => {
    const w = await world();
    const [b, c, d, e] = await Promise.all([w.make(), w.make(), w.make(), w.make()]);
    await add(w.admin.ctx, w.course.id, b.id);
    await add(w.admin.ctx, b.id, c.id);
    interceptTransactions({ afterGraphRead: barrier(2) });

    const [closing, unrelated] = await Promise.all([
      outcome(add(w.admin.ctx, c.id, w.course.id)),
      outcome(add(w.admin.ctx, d.id, e.id)),
    ]);

    expect(closing).toBe("CYCLE");
    expect(unrelated).toBe("OK");
    expect(hasCycle(await edgeRows(w.tenant.id))).toBe(false);
  });

  it("two edges that only form a cycle TOGETHER cannot both be added (the tenant lock serializes them)", async () => {
    const w = await world();
    const [x2, x3, x4] = await Promise.all([w.make(), w.make(), w.make()]);
    const x1 = w.course;
    await add(w.admin.ctx, x1.id, x2.id); // X1 requires X2
    await add(w.admin.ctx, x3.id, x4.id); // X3 requires X4
    // Each of these is fine on its own. Together they close X1>X2>X3>X4>X1. They share no
    // course, so a lock on the two courses of each edge would not order them.
    interceptTransactions({ afterGraphRead: barrier(2) });

    const results = await Promise.all([
      outcome(add(w.admin.ctx, x2.id, x3.id)),
      outcome(add(w.admin.ctx, x4.id, x1.id)),
    ]);

    expect(results.filter((r) => r === "OK")).toHaveLength(1);
    expect(results.filter((r) => r === "CYCLE")).toHaveLength(1);
    const rows = await edgeRows(w.tenant.id);
    expect(rows).toHaveLength(3);
    expect(hasCycle(rows)).toBe(false);
  });

  it("many edges racing around a ring: exactly one closing edge is refused, whatever the order", async () => {
    const w = await world();
    const ring = [w.course, ...(await Promise.all(Array.from({ length: 3 }, () => w.make())))];
    interceptTransactions({ afterGraphRead: barrier(ring.length, 300) });

    const results = await Promise.all(
      ring.map((c, i) => outcome(add(w.admin.ctx, c.id, ring[(i + 1) % ring.length].id)))
    );

    expect(results.filter((r) => r === "CYCLE")).toHaveLength(1);
    expect(results.filter((r) => r === "OK")).toHaveLength(ring.length - 1);
    expect(hasCycle(await edgeRows(w.tenant.id))).toBe(false);
  });

  it("with four prerequisites, two simultaneous additions leave exactly five, never six", async () => {
    const w = await world();
    const existing = await Promise.all(Array.from({ length: 4 }, () => w.make()));
    const [fifth, sixth] = await Promise.all([w.make(), w.make()]);
    for (const p of existing) await add(w.admin.ctx, w.course.id, p.id);
    interceptTransactions({ afterGraphRead: barrier(2) });

    const results = await Promise.all([
      outcome(add(w.admin.ctx, w.course.id, fifth.id)),
      outcome(add(w.admin.ctx, w.course.id, sixth.id)),
    ]);

    expect(results.filter((r) => r === "OK")).toHaveLength(1);
    expect(results.filter((r) => r === "LIMIT_REACHED")).toHaveLength(1);
    expect(await db.coursePrerequisite.count({ where: { courseId: w.course.id } })).toBe(5);
  });

  it("an add racing a remove of the same edge ends in a coherent state", async () => {
    const w = await world();
    const a = await w.make();
    await add(w.admin.ctx, w.course.id, a.id);

    const [addResult, removeResult] = await Promise.all([
      outcome(add(w.admin.ctx, w.course.id, a.id)),
      outcome(
        removeCoursePrerequisite(w.admin.ctx, { courseId: w.course.id, prerequisiteCourseId: a.id })
      ),
    ]);

    // Either the add saw the edge (duplicate) and the remove then deleted it, or the remove
    // ran first and the add re-created it. Never an error other than a duplicate.
    expect(removeResult).toBe("OK");
    expect(["OK", "DUPLICATE"]).toContain(addResult);
    const count = await db.coursePrerequisite.count({ where: { courseId: w.course.id } });
    expect(count).toBe(addResult === "OK" ? 1 : 0);
  });
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

describe("query counts stay constant", () => {
  function spyReads() {
    return {
      user: vi.spyOn(db.user, "findUnique"),
      course: vi.spyOn(db.course, "findFirst"),
      edges: vi.spyOn(db.coursePrerequisite, "findMany"),
      sections: vi.spyOn(db.section, "findMany"),
      enrollments: vi.spyOn(db.enrollment, "findMany"),
    };
  }
  const counts = (spies: ReturnType<typeof spyReads>) =>
    Object.values(spies).map((s) => s.mock.calls.length);

  async function measureUnmet(prerequisites: number) {
    const w = await world();
    for (let i = 0; i < prerequisites; i++) {
      const a = await w.make();
      await add(w.admin.ctx, w.course.id, a.id);
    }
    const spies = spyReads();
    const result = await unmet(w);
    const calls = counts(spies);
    vi.restoreAllMocks();
    return { calls, result };
  }

  it("getUnmetPrerequisites issues the same queries for 1 as for 5 prerequisites (no N+1)", async () => {
    const one = await measureUnmet(1);
    const five = await measureUnmet(5);

    expect(one.result).toHaveLength(1);
    expect(five.result).toHaveLength(5);
    expect(five.calls).toEqual(one.calls);
    // user, dependent course, edges, section availability, enrollments
    expect(five.calls).toEqual([1, 1, 1, 1, 1]);
  });

  it("listCoursePrerequisites is two queries for any number of prerequisites", async () => {
    async function measure(n: number) {
      const w = await world();
      for (let i = 0; i < n; i++) await add(w.admin.ctx, w.course.id, (await w.make()).id);
      const edges = vi.spyOn(db.coursePrerequisite, "findMany");
      const sections = vi.spyOn(db.section, "findMany");
      await listCoursePrerequisites(w.admin.ctx, w.course.id);
      const calls = [edges.mock.calls.length, sections.mock.calls.length];
      vi.restoreAllMocks();
      return calls;
    }

    expect(await measure(1)).toEqual(await measure(5));
    expect(await measure(5)).toEqual([1, 1]);
  });

  it("a course with no prerequisites costs only the lookups that cannot be skipped", async () => {
    const w = await world();
    const spies = spyReads();

    await unmet(w);

    expect(counts(spies)).toEqual([1, 1, 1, 0, 0]);
  });

  it("adding an edge reads the tenant's whole graph in ONE query, however large the graph", async () => {
    async function graphReads(edgesInGraph: number) {
      const w = await world();
      const nodes = await Promise.all(Array.from({ length: edgesInGraph + 1 }, () => w.make()));
      // A wide graph within the limit: each dependent has at most two prerequisites.
      for (let i = 0; i < edgesInGraph; i++) {
        await add(w.admin.ctx, nodes[i].id, nodes[i + 1].id);
      }
      const reads = vi.fn();
      interceptTransactions({ onGraphRead: reads });
      const target = await w.make();
      await add(w.admin.ctx, w.course.id, target.id);
      vi.restoreAllMocks();
      return reads.mock.calls.length;
    }

    expect(await graphReads(2)).toBe(1);
    expect(await graphReads(30)).toBe(1);
  });
});
