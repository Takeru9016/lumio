import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { prerequisiteWorld } from "@/lib/domain/course/__test__/prerequisiteFixtures";
import {
  assignRole,
  createMandatoryTraining,
  createRoleWithSkill,
  createTeamWithMember,
  mapCourseToSkill,
  setUserSkill,
} from "@/lib/domain/learning-assignment/__test__/fixtures";
import {
  createCapabilityGapAssignment,
  createMandatoryAssignment,
  createManualAssignment,
} from "@/lib/domain/learning-assignment/assignments";

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

type World = Awaited<ReturnType<typeof prerequisiteWorld>>;

async function withPrerequisite(w: World) {
  const a = await w.make();
  await w.requires(w.course.id, a.id);
  return a;
}

const manual = (w: World, extra: { note?: string } = {}) =>
  createManualAssignment(w.admin.ctx, {
    userId: w.learner.user.id,
    courseId: w.course.id,
    ...extra,
  });

async function mandatoryFor(w: World) {
  const team = await createTeamWithMember(w.tenant.id, w.learner.user.id);
  const training = await createMandatoryTraining({
    tenantId: w.tenant.id,
    courseId: w.course.id,
    teamId: team.id,
  });
  return () =>
    createMandatoryAssignment(w.admin.ctx, {
      userId: w.learner.user.id,
      mandatoryTrainingId: training.id,
    });
}

async function gapFor(w: World) {
  const { role, skill } = await createRoleWithSkill({
    tenantId: w.tenant.id,
    requiredProficiency: "INTERMEDIATE",
  });
  await assignRole(w.tenant.id, w.learner.user.id, role.id);
  await setUserSkill(w.tenant.id, w.learner.user.id, skill.id, "BEGINNER");
  await mapCourseToSkill(w.course.id, skill.id);
  return () =>
    createCapabilityGapAssignment(w.admin.ctx, {
      userId: w.learner.user.id,
      roleId: role.id,
      skillId: skill.id,
      courseId: w.course.id,
    });
}

const rows = (w: World) => ({
  enrollments: db.enrollment.count({ where: { userId: w.learner.user.id, courseId: w.course.id } }),
  assignments: db.learningAssignment.count({
    where: { userId: w.learner.user.id, courseId: w.course.id },
  }),
});

describe("assignment enrollment — prerequisites", () => {
  it("MANUAL: an unmet prerequisite refuses, names it, and creates no enrollment, assignment or notification", async () => {
    const w = await prerequisiteWorld();
    const a = await withPrerequisite(w);
    const notificationsBefore = await db.notification.count({
      where: { userId: w.learner.user.id },
    });

    const result = await manual(w);

    expect(result).toEqual({
      ok: false,
      reason: "PREREQUISITES_NOT_MET",
      prerequisites: [{ courseId: a.id, slug: a.slug, title: a.title }],
    });
    expect(await rows(w).enrollments).toBe(0);
    expect(await rows(w).assignments).toBe(0);
    expect(await db.notification.count({ where: { userId: w.learner.user.id } })).toBe(
      notificationsBefore
    );
  });

  it("MANUAL: a completed prerequisite allows the assignment, and provenance is exactly as before", async () => {
    const w = await prerequisiteWorld();
    const a = await withPrerequisite(w);
    await w.complete(w.learner.user.id, a.id);

    const result = await manual(w, { note: "  Needed for the audit.  " });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("created");
    expect(result.enrollment.created).toBe(true);
    expect(result.assignment.source).toBe("MANUAL");
    expect(result.assignment.reason).toEqual({
      assignedById: w.admin.user.id,
      assignedByName: w.admin.user.name,
      note: "Needed for the audit.",
    });
    expect(await rows(w).enrollments).toBe(1);
  });

  it("MANDATORY: an unmet prerequisite refuses; a completed one allows, with the team provenance intact", async () => {
    const w = await prerequisiteWorld();
    const a = await withPrerequisite(w);
    const assign = await mandatoryFor(w);

    expect(await assign()).toMatchObject({ ok: false, reason: "PREREQUISITES_NOT_MET" });
    expect(await rows(w).enrollments).toBe(0);
    expect(await rows(w).assignments).toBe(0);

    await w.complete(w.learner.user.id, a.id);
    const result = await assign();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assignment.source).toBe("MANDATORY");
    expect(result.assignment.reason).toMatchObject({ courseId: w.course.id });
  });

  it("CAPABILITY_GAP: an unmet prerequisite refuses; a completed one allows, with the gap provenance intact", async () => {
    const w = await prerequisiteWorld();
    const a = await withPrerequisite(w);
    const assign = await gapFor(w);

    expect(await assign()).toMatchObject({ ok: false, reason: "PREREQUISITES_NOT_MET" });
    expect(await rows(w).enrollments).toBe(0);
    expect(await rows(w).assignments).toBe(0);

    await w.complete(w.learner.user.id, a.id);
    const result = await assign();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assignment.source).toBe("CAPABILITY_GAP");
    expect(result.assignment.reason).toMatchObject({
      requiredProficiency: "INTERMEDIATE",
      currentProficiency: "BEGINNER",
    });
  });

  it("a mandatory or gap assignment that fails for its own reason keeps that reason (prerequisites do not mask it)", async () => {
    const w = await prerequisiteWorld();
    await withPrerequisite(w);
    const stranger = await createTeamWithMember(w.tenant.id, null);
    const training = await createMandatoryTraining({
      tenantId: w.tenant.id,
      courseId: w.course.id,
      teamId: stranger.id,
    });

    const result = await createMandatoryAssignment(w.admin.ctx, {
      userId: w.learner.user.id,
      mandatoryTrainingId: training.id,
    });

    expect(result).toEqual({ ok: false, reason: "LEARNER_NOT_IN_TEAM" });
  });

  it("all prerequisites are needed, and only the unmet ones are reported", async () => {
    const w = await prerequisiteWorld();
    const [a, b] = await Promise.all([w.make(), w.make()]);
    await w.requires(w.course.id, a.id);
    await w.requires(w.course.id, b.id);
    await w.complete(w.learner.user.id, a.id);

    const result = await manual(w);

    expect(result).toMatchObject({ ok: false, reason: "PREREQUISITES_NOT_MET" });
    expect(!result.ok && result.prerequisites?.map((p) => p.slug)).toEqual([b.slug]);
  });

  it.each([
    ["ACTIVE", "ACTIVE"],
    ["REFUNDED", "REFUNDED"],
  ] as const)("a %s enrollment on the prerequisite does not satisfy it", async (_n, status) => {
    const w = await prerequisiteWorld();
    const a = await withPrerequisite(w);
    await w.enroll(w.learner.user.id, a.id, status);

    expect(await manual(w)).toMatchObject({ ok: false, reason: "PREREQUISITES_NOT_MET" });
  });

  it.each([
    ["archived", (w: World, id: string) => w.archive(id)],
    ["a draft", (w: World, id: string) => w.unpublish(id)],
    ["without a published lesson", (w: World, id: string) => w.removeLessons(id)],
  ])("a retired prerequisite (%s) does not block", async (_n, retire) => {
    const w = await prerequisiteWorld();
    const a = await withPrerequisite(w);
    await retire(w, a.id);

    expect((await manual(w)).ok).toBe(true);
  });

  it("a prerequisite of another tenant cannot influence the result", async () => {
    const w = await prerequisiteWorld();
    const foreign = await prerequisiteWorld();
    await w.requires(w.course.id, foreign.course.id);

    expect((await manual(w)).ok).toBe(true);
  });
});

describe("assignment enrollment — enrollment reuse", () => {
  it("an ACTIVE enrollment that already exists is reused and grandfathered: no second enrollment, the assignment is made", async () => {
    const w = await prerequisiteWorld();
    const existing = await w.enroll(w.learner.user.id, w.course.id, "ACTIVE");
    await withPrerequisite(w);

    const result = await manual(w);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.enrollment).toMatchObject({ id: existing.id, created: false });
    expect(await rows(w).enrollments).toBe(1);
  });

  it("a COMPLETED enrollment is not blocked by a prerequisite added later, and stays COMPLETED", async () => {
    const w = await prerequisiteWorld();
    await w.complete(w.learner.user.id, w.course.id);
    await withPrerequisite(w);

    const result = await manual(w);

    expect(result.ok && result.status).toBe("COMPLETED");
    expect(await rows(w).enrollments).toBe(1);
  });

  it("a REFUNDED enrollment keeps its existing refusal (ENROLLMENT_REFUNDED), prerequisites or not", async () => {
    const w = await prerequisiteWorld();
    await w.enroll(w.learner.user.id, w.course.id, "REFUNDED");
    await withPrerequisite(w);

    expect(await manual(w)).toEqual({ ok: false, reason: "ENROLLMENT_REFUNDED" });
    expect(await rows(w).enrollments).toBe(1);
  });

  it("no duplicate enrollment: repeating an allowed assignment leaves one enrollment and one assignment", async () => {
    const w = await prerequisiteWorld();
    const a = await withPrerequisite(w);
    await w.complete(w.learner.user.id, a.id);

    const first = await manual(w);
    const second = await manual(w);

    expect(first.ok && first.outcome).toBe("created");
    expect(second.ok && second.outcome).toBe("existing");
    expect(await rows(w).enrollments).toBe(1);
    expect(await rows(w).assignments).toBe(1);
  });

  it("once refused, the very same assignment succeeds after the prerequisite is completed", async () => {
    const w = await prerequisiteWorld();
    const a = await withPrerequisite(w);
    expect((await manual(w)).ok).toBe(false);

    await w.complete(w.learner.user.id, a.id);

    expect((await manual(w)).ok).toBe(true);
    expect(await rows(w).enrollments).toBe(1);
  });
});

describe("assignment enrollment — concurrency", () => {
  it("eight simultaneous assignments with an unmet prerequisite all refuse, and leave no enrollment or assignment", async () => {
    const w = await prerequisiteWorld();
    await withPrerequisite(w);

    const results = await Promise.all(Array.from({ length: 8 }, () => manual(w)));

    for (const r of results)
      expect(r).toMatchObject({ ok: false, reason: "PREREQUISITES_NOT_MET" });
    expect(await rows(w).enrollments).toBe(0);
    expect(await rows(w).assignments).toBe(0);
  });

  it("mixed sources racing on an unmet prerequisite: none of MANUAL, MANDATORY or CAPABILITY_GAP gets through", async () => {
    const w = await prerequisiteWorld();
    await withPrerequisite(w);
    const mandatory = await mandatoryFor(w);
    const gap = await gapFor(w);

    const results = await Promise.all([
      manual(w),
      mandatory(),
      gap(),
      manual(w),
      mandatory(),
      gap(),
    ]);

    for (const r of results)
      expect(r).toMatchObject({ ok: false, reason: "PREREQUISITES_NOT_MET" });
    expect(await rows(w).enrollments).toBe(0);
    expect(await rows(w).assignments).toBe(0);
  });

  it("with the prerequisite met, eight simultaneous assignments converge on one enrollment and one assignment", async () => {
    const w = await prerequisiteWorld();
    const a = await withPrerequisite(w);
    await w.complete(w.learner.user.id, a.id);

    const results = await Promise.all(Array.from({ length: 8 }, () => manual(w)));

    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.ok && r.outcome === "created")).toHaveLength(1);
    expect(await rows(w).enrollments).toBe(1);
    expect(await rows(w).assignments).toBe(1);
  });

  it("a completion racing an assignment ends in a valid state: refused with nothing created, or allowed with one of each", async () => {
    for (let i = 0; i < 6; i++) {
      const w = await prerequisiteWorld();
      const a = await withPrerequisite(w);
      await w.enroll(w.learner.user.id, a.id, "ACTIVE");

      const [, result] = await Promise.all([
        w.completeExisting(w.learner.user.id, a.id),
        manual(w),
      ]);

      if (result.ok) {
        expect(await rows(w).enrollments).toBe(1);
        expect(await rows(w).assignments).toBe(1);
      } else {
        expect(result.reason).toBe("PREREQUISITES_NOT_MET");
        expect(await rows(w).enrollments).toBe(0);
        expect(await rows(w).assignments).toBe(0);
      }
    }
  });
});

/**
 * Records every model call the assignment transaction makes ("enrollment.createMany",
 * "coursePrerequisite.findMany", ...) in the order it makes them, so ordering can be
 * asserted directly instead of inferred from a rollback that removes the evidence.
 */
function recordTransactions() {
  const events: string[] = [];
  const original = db.$transaction.bind(db) as (fn: (tx: unknown) => Promise<unknown>) => unknown;
  const spy = vi.spyOn(db, "$transaction").mockImplementation(((
    fn: (tx: unknown) => Promise<unknown>
  ) =>
    original((tx) =>
      fn(
        new Proxy(tx as object, {
          get(target, model, receiver) {
            const delegate = Reflect.get(target, model, receiver);
            if (typeof model !== "string" || typeof delegate !== "object" || delegate === null) {
              return delegate;
            }
            return new Proxy(delegate, {
              get(d, method) {
                const member = Reflect.get(d, method);
                if (typeof member !== "function") return member;
                return (...args: unknown[]) => {
                  events.push(`${model}.${String(method)}`);
                  return member.apply(d, args);
                };
              },
            });
          },
        })
      )
    )) as never);
  return { events, spy };
}

const WRITE = /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)$/;
const writesIn = (events: string[]) => events.filter((e) => WRITE.test(e));
const PREREQUISITE_READ = "coursePrerequisite.findMany";

describe("assignment ordering — the prerequisite gate runs before any enrollment write", () => {
  const sources = [
    ["MANUAL", (w: World) => Promise.resolve(() => manual(w))],
    ["MANDATORY", mandatoryFor],
    ["CAPABILITY_GAP", gapFor],
  ] as const;

  it.each(sources)(
    "%s: an unmet prerequisite refuses before any enrollment or assignment write is even attempted",
    async (_source, prepare) => {
      const w = await prerequisiteWorld();
      await withPrerequisite(w);
      const assign = await prepare(w);
      const { events } = recordTransactions();

      const result = await assign();

      expect(result).toMatchObject({ ok: false, reason: "PREREQUISITES_NOT_MET" });
      expect(events).toContain(PREREQUISITE_READ);
      expect(writesIn(events)).toEqual([]);
      expect(await rows(w).enrollments).toBe(0);
      expect(await rows(w).assignments).toBe(0);
    }
  );

  it("with the prerequisite met, the gate's reads precede the enrollment write, which precedes the assignment write", async () => {
    const w = await prerequisiteWorld();
    const a = await withPrerequisite(w);
    await w.complete(w.learner.user.id, a.id);
    const { events } = recordTransactions();

    const result = await manual(w);

    expect(result.ok).toBe(true);
    const gateReads = events.flatMap((e, i) => (e === PREREQUISITE_READ ? [i] : []));
    const enrollmentWrite = events.indexOf("enrollment.createMany");
    const assignmentWrite = events.indexOf("learningAssignment.createMany");
    expect(gateReads).toHaveLength(1);
    expect(gateReads[0]).toBeLessThan(enrollmentWrite);
    expect(enrollmentWrite).toBeGreaterThanOrEqual(0);
    expect(enrollmentWrite).toBeLessThan(assignmentWrite);
  });

  it("an existing ACTIVE enrollment is reused without consulting the gate, and no enrollment is created", async () => {
    const w = await prerequisiteWorld();
    const existing = await w.enroll(w.learner.user.id, w.course.id, "ACTIVE");
    await withPrerequisite(w);
    const { events } = recordTransactions();

    const result = await manual(w);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.enrollment).toMatchObject({ id: existing.id, created: false });
    expect(events).not.toContain(PREREQUISITE_READ);
    expect(await rows(w).enrollments).toBe(1);
  });

  it("an existing COMPLETED enrollment is reused without consulting the gate, and stays COMPLETED", async () => {
    const w = await prerequisiteWorld();
    const existing = await w.complete(w.learner.user.id, w.course.id);
    await withPrerequisite(w);
    const { events } = recordTransactions();

    const result = await manual(w);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.enrollment).toMatchObject({ id: existing.id, created: false });
    expect(events).not.toContain(PREREQUISITE_READ);
    expect((await db.enrollment.findUniqueOrThrow({ where: { id: existing.id } })).status).toBe(
      "COMPLETED"
    );
  });

  it("an existing REFUNDED enrollment is refused as ENROLLMENT_REFUNDED, not as an unmet prerequisite, and nothing is written", async () => {
    const w = await prerequisiteWorld();
    const existing = await w.enroll(w.learner.user.id, w.course.id, "REFUNDED");
    await withPrerequisite(w);
    const { events } = recordTransactions();

    const result = await manual(w);

    expect(result).toEqual({ ok: false, reason: "ENROLLMENT_REFUNDED" });
    expect(events).not.toContain(PREREQUISITE_READ);
    expect(writesIn(events)).toEqual([]);
    expect((await db.enrollment.findUniqueOrThrow({ where: { id: existing.id } })).status).toBe(
      "REFUNDED"
    );
    expect(await rows(w).assignments).toBe(0);
  });

  it("authorization comes first: a non-admin actor never reaches a transaction, and is not told about prerequisites", async () => {
    const w = await prerequisiteWorld();
    await withPrerequisite(w);
    const { events, spy } = recordTransactions();

    await expect(
      createManualAssignment(w.instructor.ctx, {
        userId: w.learner.user.id,
        courseId: w.course.id,
      })
    ).rejects.toThrow();

    expect(spy).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("tenant isolation comes first: another tenant's learner and course are refused without a transaction", async () => {
    const w = await prerequisiteWorld();
    await withPrerequisite(w);
    const foreign = await prerequisiteWorld();
    const { spy } = recordTransactions();

    expect(
      await createManualAssignment(foreign.admin.ctx, {
        userId: w.learner.user.id,
        courseId: w.course.id,
      })
    ).toEqual({ ok: false, reason: "LEARNER_NOT_ELIGIBLE" });
    expect(
      await createManualAssignment(foreign.admin.ctx, {
        userId: foreign.learner.user.id,
        courseId: w.course.id,
      })
    ).toEqual({ ok: false, reason: "COURSE_NOT_FOUND" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("an unpublished or paid course keeps its own refusal and is not sent to the gate", async () => {
    const w = await prerequisiteWorld();
    const draft = await w.make({ status: "DRAFT" });
    const paid = await w.make({ price: 500 });
    const a = await w.make();
    await w.requires(draft.id, a.id);
    await w.requires(paid.id, a.id);
    const { events } = recordTransactions();

    const draftResult = await createManualAssignment(w.admin.ctx, {
      userId: w.learner.user.id,
      courseId: draft.id,
    });
    const paidResult = await createManualAssignment(w.admin.ctx, {
      userId: w.learner.user.id,
      courseId: paid.id,
    });

    expect(draftResult).toEqual({ ok: false, reason: "COURSE_NOT_PUBLISHED" });
    expect(paidResult).toEqual({ ok: false, reason: "COURSE_REQUIRES_PAYMENT" });
    expect(events).toEqual([]);
  });

  it("eight simultaneous assignments against an unmet prerequisite: not one of them attempts an enrollment write", async () => {
    const w = await prerequisiteWorld();
    await withPrerequisite(w);
    const { events } = recordTransactions();

    const results = await Promise.all(Array.from({ length: 8 }, () => manual(w)));

    for (const r of results) {
      expect(r).toMatchObject({ ok: false, reason: "PREREQUISITES_NOT_MET" });
    }
    expect(events.filter((e) => e === PREREQUISITE_READ)).toHaveLength(8);
    expect(writesIn(events)).toEqual([]);
    expect(await rows(w).enrollments).toBe(0);
  });
});
