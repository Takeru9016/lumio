import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  createCourseIn,
  createScenario,
  createTenant,
  createTenantlessStudent,
  createUserIn,
} from "@/lib/domain/learning-assignment/__test__/fixtures";
import {
  ADMIN_PAGE_MAX,
  ADMIN_PAGE_SIZE,
  AssignmentCursorError,
  listAssignmentOptions,
  listOrgAssignments,
} from "@/lib/domain/learning-assignment/adminAssignments";
import {
  cancelAssignment,
  createManualAssignment,
} from "@/lib/domain/learning-assignment/assignments";
import {
  type AssignmentStatus,
  deriveAssignmentStatus,
} from "@/lib/domain/learning-assignment/status";

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

type Scenario = Awaited<ReturnType<typeof createScenario>>;

async function assign(
  s: Scenario,
  courseId: string,
  extra: { learnerId?: string; dueDate?: Date | null; note?: string } = {}
) {
  const result = await createManualAssignment(s.admin.ctx, {
    userId: extra.learnerId ?? s.learner.user.id,
    courseId,
    ...(extra.dueDate !== undefined ? { dueDate: extra.dueDate } : {}),
    ...(extra.note !== undefined ? { note: extra.note } : {}),
  });
  if (!result.ok) throw new Error(`setup failed: ${result.reason}`);
  return result.assignment;
}

describe("listOrgAssignments — what an administrator sees", () => {
  it("lists the tenant's assignments with learner, course, source, status, dates and provenance", async () => {
    const s = await createScenario();
    const due = new Date("2027-03-01T23:59:59.999Z");
    const a = await assign(s, s.course.id, { dueDate: due, note: "Before onboarding." });

    const { assignments, hasMore, nextCursor } = await listOrgAssignments(s.admin.ctx);

    expect(hasMore).toBe(false);
    expect(nextCursor).toBeNull();
    expect(assignments).toEqual([
      {
        id: a.id,
        learner: { name: s.learner.user.name, email: s.learner.user.email },
        course: { title: s.course.title, slug: s.course.slug },
        source: "MANUAL",
        reason: { kind: "MANUAL", assignedByName: s.admin.user.name, note: "Before onboarding." },
        status: "ASSIGNED",
        dueDate: due,
        createdAt: a.createdAt,
        cancellation: null,
        previousCancellation: null,
      },
    ]);
  });

  it("returns newest first, deterministically", async () => {
    const s = await createScenario();
    const second = await createCourseIn(s.tenant.id, s.instructor.user.id);
    const third = await createCourseIn(s.tenant.id, s.instructor.user.id);
    const first = await assign(s, s.course.id);
    const b = await assign(s, second.course.id);
    const c = await assign(s, third.course.id);

    const ids = (await listOrgAssignments(s.admin.ctx)).assignments.map((x) => x.id);

    expect(ids).toEqual([c.id, b.id, first.id]);
    expect((await listOrgAssignments(s.admin.ctx)).assignments.map((x) => x.id)).toEqual(ids);
  });

  it("includes cancelled assignments (the learner read hides them) and says who and when", async () => {
    const s = await createScenario();
    const a = await assign(s, s.course.id);
    await cancelAssignment(s.admin.ctx, a.id);

    const [row] = (await listOrgAssignments(s.admin.ctx)).assignments;

    expect(row.status).toBe("CANCELLED");
    expect(row.cancellation?.byName).toBe(s.admin.user.name);
    expect(row.cancellation?.at).toBeInstanceOf(Date);
    expect(row.previousCancellation).toBeNull();
  });

  it("after reactivation the assignment is active again and the history is still shown (M-2)", async () => {
    const s = await createScenario();
    const a = await assign(s, s.course.id);
    await cancelAssignment(s.admin.ctx, a.id);
    await assign(s, s.course.id);

    const [row] = (await listOrgAssignments(s.admin.ctx)).assignments;

    expect(row.id).toBe(a.id);
    expect(row.status).toBe("ASSIGNED");
    expect(row.cancellation).toBeNull();
    expect(row.previousCancellation).toEqual({
      at: expect.any(Date),
      byName: s.admin.user.name,
      count: 1,
    });
  });

  it("never carries user, course, tenant or assigner ids, only the assignment's own id", async () => {
    const s = await createScenario();
    await assign(s, s.course.id);

    const text = JSON.stringify((await listOrgAssignments(s.admin.ctx)).assignments);

    for (const forbidden of [
      s.learner.user.id,
      s.course.id,
      s.tenant.id,
      s.admin.user.id,
      "userId",
      "courseId",
      "tenantId",
      "assignedById",
      "sourceKey",
    ]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });
});

describe("listOrgAssignments — tenant isolation", () => {
  it("shows Tenant A's assignments to Tenant A's admin and none of Tenant B's", async () => {
    const a = await createScenario();
    const b = await createScenario();
    const forA = await assign(a, a.course.id);
    const forB = await assign(b, b.course.id);

    const asA = (await listOrgAssignments(a.admin.ctx)).assignments.map((x) => x.id);
    const asB = (await listOrgAssignments(b.admin.ctx)).assignments.map((x) => x.id);

    expect(asA).toEqual([forA.id]);
    expect(asB).toEqual([forB.id]);
  });

  it("hides a row that belongs to a previous tenant of the same learner", async () => {
    const s = await createScenario();
    const previous = await createTenant();
    await db.learningAssignment.create({
      data: {
        tenantId: previous.id,
        userId: s.learner.user.id,
        courseId: s.course.id,
        source: "MANUAL",
        sourceKey: `manual:${s.course.id}`,
        reason: { assignedById: "x", assignedByName: "Old admin" },
      },
    });

    expect((await listOrgAssignments(s.admin.ctx)).assignments).toEqual([]);
  });

  it("ignores any tenant supplied by the caller: the tenant is the session's", async () => {
    const a = await createScenario();
    const b = await createScenario();
    await assign(b, b.course.id);

    const forged = await listOrgAssignments(
      { ...a.admin.ctx, tenantId: a.tenant.id },
      // A forged extra field on the filters must be ignored: the tenant is the session's.
      { tenantId: b.tenant.id } as never
    );

    expect(forged.assignments).toEqual([]);
  });

  it("does not list assignments of a learner who has been deleted", async () => {
    const s = await createScenario();
    await assign(s, s.course.id);
    await db.user.update({ where: { id: s.learner.user.id }, data: { deletedAt: new Date() } });

    expect((await listOrgAssignments(s.admin.ctx)).assignments).toEqual([]);
  });
});

describe("listOrgAssignments — status is derived per learner and course", () => {
  it("two learners on the same course get their own statuses, never each other's", async () => {
    const s = await createScenario();
    const second = await createUserIn(s.tenant.id, "STUDENT");
    const third = await createUserIn(s.tenant.id, "STUDENT");
    await assign(s, s.course.id);
    await assign(s, s.course.id, { learnerId: second.user.id });
    await assign(s, s.course.id, { learnerId: third.user.id });
    // Only the first has started; only the second has completed.
    await db.lessonProgress.create({
      data: { userId: s.learner.user.id, lessonId: s.lesson.id, isCompleted: true },
    });
    await db.enrollment.update({
      where: { userId_courseId: { userId: second.user.id, courseId: s.course.id } },
      data: { status: "COMPLETED", completedAt: new Date() },
    });

    const byEmail = new Map(
      (await listOrgAssignments(s.admin.ctx)).assignments.map((x) => [x.learner.email, x.status])
    );

    expect(byEmail.get(s.learner.user.email)).toBe("STARTED");
    expect(byEmail.get(second.user.email)).toBe("COMPLETED");
    expect(byEmail.get(third.user.email)).toBe("ASSIGNED");
  });

  it("derives all five statuses", async () => {
    const s = await createScenario();
    const now = new Date("2026-09-20T12:00:00.000Z");
    const c = await Promise.all(
      Array.from({ length: 5 }, () => createCourseIn(s.tenant.id, s.instructor.user.id))
    );
    const [assigned, started, overdue, completed, cancelled] = await Promise.all(
      c.map((x, i) =>
        assign(s, x.course.id, {
          dueDate: i === 2 ? new Date("2026-01-01T00:00:00.000Z") : undefined,
        })
      )
    );
    await db.lessonProgress.create({
      data: { userId: s.learner.user.id, lessonId: c[1].lesson.id, isCompleted: true },
    });
    await db.enrollment.update({
      where: { userId_courseId: { userId: s.learner.user.id, courseId: c[3].course.id } },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    await cancelAssignment(s.admin.ctx, cancelled.id);

    const byId = new Map(
      (await listOrgAssignments(s.admin.ctx, {}, { now })).assignments.map((x) => [x.id, x.status])
    );

    expect(byId.get(assigned.id)).toBe("ASSIGNED");
    expect(byId.get(started.id)).toBe("STARTED");
    expect(byId.get(overdue.id)).toBe("OVERDUE");
    expect(byId.get(completed.id)).toBe("COMPLETED");
    expect(byId.get(cancelled.id)).toBe("CANCELLED");
  });
});

describe("listOrgAssignments — filters", () => {
  async function mixed() {
    const s = await createScenario();
    const now = new Date("2026-09-20T12:00:00.000Z");
    const c = await Promise.all(
      Array.from({ length: 4 }, () => createCourseIn(s.tenant.id, s.instructor.user.id))
    );
    const plain = await assign(s, c[0].course.id);
    const late = await assign(s, c[1].course.id, { dueDate: new Date("2026-01-01T00:00:00.000Z") });
    const gone = await assign(s, c[2].course.id);
    await cancelAssignment(s.admin.ctx, gone.id);
    const team = await db.team.create({ data: { name: "Support", tenantId: s.tenant.id } });
    const training = await db.mandatoryTraining.create({
      data: {
        tenantId: s.tenant.id,
        courseId: c[3].course.id,
        teamId: team.id,
        dueDate: new Date("2099-01-01T00:00:00.000Z"),
      },
    });
    const mandatory = await db.learningAssignment.create({
      data: {
        tenantId: s.tenant.id,
        userId: s.learner.user.id,
        courseId: c[3].course.id,
        source: "MANDATORY",
        sourceKey: `mandatory:${training.id}`,
        mandatoryTrainingId: training.id,
        reason: { teamName: "Support" },
        dueDate: training.dueDate,
      },
    });
    return { s, now, plain, late, gone, mandatory };
  }

  it("filters by source", async () => {
    const { s, now, mandatory } = await mixed();

    const only = await listOrgAssignments(s.admin.ctx, { source: "MANDATORY" }, { now });
    const manual = await listOrgAssignments(s.admin.ctx, { source: "MANUAL" }, { now });

    expect(only.assignments.map((x) => x.id)).toEqual([mandatory.id]);
    expect(manual.assignments).toHaveLength(3);
    expect(manual.assignments.every((x) => x.source === "MANUAL")).toBe(true);
  });

  it.each([
    ["ASSIGNED", 2],
    ["OVERDUE", 1],
    ["CANCELLED", 1],
    ["STARTED", 0],
    ["COMPLETED", 0],
  ] as const)("filters by status %s", async (status, expected) => {
    const { s, now } = await mixed();

    const list = await listOrgAssignments(s.admin.ctx, { status }, { now });

    expect(list.assignments).toHaveLength(expected);
    expect(list.assignments.every((x) => x.status === status)).toBe(true);
  });

  it("combines source and status", async () => {
    const { s, now, late } = await mixed();

    const list = await listOrgAssignments(
      s.admin.ctx,
      { source: "MANUAL", status: "OVERDUE" },
      { now }
    );

    expect(list.assignments.map((x) => x.id)).toEqual([late.id]);
  });

  it("no filter returns everything, cancelled included", async () => {
    const { s, now } = await mixed();

    expect((await listOrgAssignments(s.admin.ctx, {}, { now })).assignments).toHaveLength(4);
  });
});

describe("listOrgAssignments — provenance is shown in words, from a defensive projection", () => {
  it("mandatory: the team; capability gap: role, skill and levels", async () => {
    const s = await createScenario();
    const c = await createCourseIn(s.tenant.id, s.instructor.user.id);
    const base = { tenantId: s.tenant.id, userId: s.learner.user.id, courseId: c.course.id };
    await db.learningAssignment.create({
      data: {
        ...base,
        source: "CAPABILITY_GAP",
        sourceKey: "gap:r:s",
        reason: {
          roleId: "r",
          roleName: "Data Analyst",
          skillId: "s",
          skillName: "SQL",
          requiredProficiency: "ADVANCED",
          currentProficiency: "BEGINNER",
        },
      },
    });

    const [row] = (await listOrgAssignments(s.admin.ctx)).assignments;

    expect(row.reason).toEqual({
      kind: "CAPABILITY_GAP",
      roleName: "Data Analyst",
      skillName: "SQL",
      requiredProficiency: "ADVANCED",
      currentProficiency: "BEGINNER",
    });
    expect(JSON.stringify(row.reason)).not.toMatch(/"(roleId|skillId|courseId)"/);
  });

  it.each([null, "garbage", 42, [], { roleName: 7, requiredProficiency: "GOD" }])(
    "a malformed snapshot (%j) degrades to a safe reason instead of failing the list",
    async (reason) => {
      const s = await createScenario();
      const c = await createCourseIn(s.tenant.id, s.instructor.user.id);
      await db.learningAssignment.create({
        data: {
          tenantId: s.tenant.id,
          userId: s.learner.user.id,
          courseId: c.course.id,
          source: "CAPABILITY_GAP",
          sourceKey: "gap:x:y",
          reason: reason as never,
        },
      });

      const [row] = (await listOrgAssignments(s.admin.ctx)).assignments;

      expect(row.reason).toEqual({
        kind: "CAPABILITY_GAP",
        roleName: null,
        skillName: null,
        requiredProficiency: null,
        currentProficiency: null,
      });
    }
  );
});

describe("listOrgAssignments — filters are applied before the page is cut", () => {
  /** Learners on one course: the cheapest way to get many distinct assignments. */
  async function manyAssignments(s: Scenario, count: number, dueDate?: Date) {
    const made = [];
    for (let i = 0; i < count; i++) {
      const learner = await createUserIn(s.tenant.id, "STUDENT");
      made.push(await assign(s, s.course.id, { learnerId: learner.user.id, dueDate }));
    }
    return made;
  }

  async function collect(
    s: Scenario,
    filters: Parameters<typeof listOrgAssignments>[1],
    limit: number,
    now: Date
  ) {
    const pages: string[][] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 50; guard++) {
      const page = await listOrgAssignments(s.admin.ctx, filters, { limit, cursor, now });
      pages.push(page.assignments.map((x) => x.id));
      expect(page.hasMore).toBe(page.nextCursor !== null);
      if (!page.nextCursor) return pages;
      cursor = page.nextCursor;
    }
    throw new Error("paging did not terminate");
  }

  it("an old overdue assignment behind many newer non-overdue ones is still found (the 200-row window bug)", async () => {
    const s = await createScenario();
    const now = new Date("2026-09-20T12:00:00.000Z");
    const overdue = await manyAssignments(s, 3, new Date("2026-01-01T00:00:00.000Z"));
    await manyAssignments(s, 6, new Date("2099-01-01T00:00:00.000Z"));

    const pages = await collect(s, { status: "OVERDUE" }, 2, now);

    expect(pages.flat().sort()).toEqual(overdue.map((x) => x.id).sort());
    expect(pages.map((p) => p.length)).toEqual([2, 1]);
  });

  it("a filtered first page is full when enough rows match, wherever they sit in the newest-first order", async () => {
    const s = await createScenario();
    const now = new Date("2026-09-20T12:00:00.000Z");
    await manyAssignments(s, 5, new Date("2026-01-01T00:00:00.000Z"));
    await manyAssignments(s, 5, new Date("2099-01-01T00:00:00.000Z"));

    const page = await listOrgAssignments(s.admin.ctx, { status: "OVERDUE" }, { limit: 4, now });

    expect(page.assignments).toHaveLength(4);
    expect(page.assignments.every((x) => x.status === "OVERDUE")).toBe(true);
    expect(page.hasMore).toBe(true);
  });

  it("hasMore describes the FILTERED list: false when the last matching row is on this page", async () => {
    const s = await createScenario();
    const now = new Date("2026-09-20T12:00:00.000Z");
    await manyAssignments(s, 2, new Date("2026-01-01T00:00:00.000Z"));
    await manyAssignments(s, 4, new Date("2099-01-01T00:00:00.000Z"));

    const page = await listOrgAssignments(s.admin.ctx, { status: "OVERDUE" }, { limit: 2, now });

    expect(page.assignments).toHaveLength(2);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("the source filter is applied before the page is cut too", async () => {
    const s = await createScenario();
    const c = await createCourseIn(s.tenant.id, s.instructor.user.id);
    const team = await db.team.create({ data: { name: "Support", tenantId: s.tenant.id } });
    const training = await db.mandatoryTraining.create({
      data: {
        tenantId: s.tenant.id,
        courseId: c.course.id,
        teamId: team.id,
        dueDate: new Date("2099-01-01T00:00:00.000Z"),
      },
    });
    const learner = await createUserIn(s.tenant.id, "STUDENT");
    const mandatory = await db.learningAssignment.create({
      data: {
        tenantId: s.tenant.id,
        userId: learner.user.id,
        courseId: c.course.id,
        source: "MANDATORY",
        sourceKey: `mandatory:${training.id}`,
        mandatoryTrainingId: training.id,
        reason: { teamName: "Support" },
      },
    });
    await manyAssignments(s, 5);

    const page = await listOrgAssignments(s.admin.ctx, { source: "MANDATORY" }, { limit: 2 });

    expect(page.assignments.map((x) => x.id)).toEqual([mandatory.id]);
    expect(page.hasMore).toBe(false);
  });

  it("paging walks every row exactly once, newest first, with no filter", async () => {
    const s = await createScenario();
    const made = await manyAssignments(s, 7);

    const pages = await collect(s, {}, 3, new Date());

    expect(pages.map((p) => p.length)).toEqual([3, 3, 1]);
    const ids = pages.flat();
    expect(new Set(ids).size).toBe(7);
    expect(ids.sort()).toEqual(made.map((x) => x.id).sort());
  });

  it("a row created after page 1 was read does not shift or repeat page 2", async () => {
    const s = await createScenario();
    await manyAssignments(s, 4);

    const first = await listOrgAssignments(s.admin.ctx, {}, { limit: 2 });
    await manyAssignments(s, 1);
    const second = await listOrgAssignments(
      s.admin.ctx,
      {},
      { limit: 2, cursor: first.nextCursor ?? undefined }
    );

    const seen = [...first.assignments, ...second.assignments].map((x) => x.id);
    expect(new Set(seen).size).toBe(4);
    expect(second.hasMore).toBe(false);
  });

  it("a row that vanishes between the page query and the load never makes the next page skip rows", async () => {
    const s = await createScenario();
    const made = await manyAssignments(s, 5);
    const realFindMany = db.learningAssignment.findMany.bind(db.learningAssignment);
    vi.spyOn(db.learningAssignment, "findMany").mockImplementationOnce((async (args: never) => {
      const loaded = await realFindMany(args);
      // Drop the row the page ends on, as if its learner had just been removed.
      return loaded
        .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime() || (y.id < x.id ? -1 : 1))
        .slice(0, -1);
    }) as never);

    const first = await listOrgAssignments(s.admin.ctx, {}, { limit: 3 });
    vi.restoreAllMocks();
    const rest = await listOrgAssignments(
      s.admin.ctx,
      {},
      { limit: 3, cursor: first.nextCursor ?? undefined }
    );

    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    expect(first.assignments).toHaveLength(2);
    // Together with the row that vanished from the first page, nothing is skipped or repeated.
    const seen = new Set([...first.assignments, ...rest.assignments].map((x) => x.id));
    expect(seen.size).toBe(4);
    expect(rest.assignments).toHaveLength(2);
    expect(made.filter((m) => !seen.has(m.id))).toHaveLength(1);
  });

  it("hasMore with nothing loadable still carries a cursor, so the list is never a dead end", async () => {
    const s = await createScenario();
    await manyAssignments(s, 3);
    vi.spyOn(db.learningAssignment, "findMany").mockResolvedValueOnce([] as never);

    const page = await listOrgAssignments(s.admin.ctx, {}, { limit: 2 });

    expect(page.assignments).toEqual([]);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).not.toBeNull();
  });

  it("the SQL status filter agrees with deriveAssignmentStatus for every combination, including the due-date boundary", async () => {
    const s = await createScenario();
    const now = new Date("2026-09-20T12:00:00.000Z");
    const dues = [
      null,
      new Date(now.getTime() - 1),
      new Date(now.getTime()),
      new Date(now.getTime() + 1),
    ];
    const expected = new Map<string, AssignmentStatus>();

    for (const dueDate of dues) {
      for (const cancelled of [false, true]) {
        for (const completed of [false, true]) {
          for (const progress of [false, true]) {
            const learner = await createUserIn(s.tenant.id, "STUDENT");
            const a = await assign(s, s.course.id, { learnerId: learner.user.id, dueDate });
            if (cancelled) {
              await db.learningAssignment.update({
                where: { id: a.id },
                data: { cancelledAt: new Date("2026-09-01T00:00:00.000Z") },
              });
            }
            if (completed) {
              await db.enrollment.update({
                where: { userId_courseId: { userId: learner.user.id, courseId: s.course.id } },
                data: { status: "COMPLETED", completedAt: new Date() },
              });
            }
            if (progress) {
              await db.lessonProgress.create({
                data: { userId: learner.user.id, lessonId: s.lesson.id, isCompleted: false },
              });
            }
            expected.set(
              a.id,
              deriveAssignmentStatus({
                cancelledAt: cancelled ? new Date("2026-09-01T00:00:00.000Z") : null,
                dueDate,
                enrollmentStatus: completed ? "COMPLETED" : "ACTIVE",
                hasLessonProgress: progress,
                now,
              })
            );
          }
        }
      }
    }
    expect(expected.size).toBe(32);

    for (const status of ["ASSIGNED", "STARTED", "OVERDUE", "COMPLETED", "CANCELLED"] as const) {
      const want = [...expected].filter(([, v]) => v === status).map(([id]) => id);
      const got = await listOrgAssignments(s.admin.ctx, { status }, { now, limit: ADMIN_PAGE_MAX });

      expect(want.length, `fixture covers ${status}`).toBeGreaterThan(0);
      expect(got.assignments.map((x) => x.id).sort(), status).toEqual(want.sort());
      expect(
        got.assignments.every((x) => x.status === status),
        status
      ).toBe(true);
    }
    const all = await listOrgAssignments(s.admin.ctx, {}, { now, limit: ADMIN_PAGE_MAX });
    expect(new Map(all.assignments.map((x) => [x.id, x.status]))).toEqual(expected);
  });
});

describe("listOrgAssignments — cursor", () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");

  it.each([
    ["not base64 json", "%%%not-a-cursor%%%"],
    ["an empty object", encode({})],
    ["a numeric id", encode({ createdAt: "2026-01-01T00:00:00.000Z", id: 7 })],
    ["a non-date createdAt", encode({ createdAt: "yesterday", id: "abc" })],
    ["a date that is not in canonical form", encode({ createdAt: "2026-01-01", id: "abc" })],
    ["an empty id", encode({ createdAt: "2026-01-01T00:00:00.000Z", id: "" })],
    ["an oversized id", encode({ createdAt: "2026-01-01T00:00:00.000Z", id: "x".repeat(65) })],
    ["an array", encode([])],
  ])("rejects %s instead of treating it as the first page", async (_name, cursor) => {
    const s = await createScenario();
    await assign(s, s.course.id);

    await expect(listOrgAssignments(s.admin.ctx, {}, { cursor })).rejects.toBeInstanceOf(
      AssignmentCursorError
    );
  });

  it("a cursor cannot reach another tenant's rows: it is only a position, the tenant is the session's", async () => {
    const a = await createScenario();
    const b = await createScenario();
    const made = [];
    for (let i = 0; i < 3; i++) {
      const learner = await createUserIn(a.tenant.id, "STUDENT");
      made.push(await assign(a, a.course.id, { learnerId: learner.user.id }));
    }
    const forB = await assign(b, b.course.id);
    const aPage = await listOrgAssignments(a.admin.ctx, {}, { limit: 1 });

    const asB = await listOrgAssignments(
      b.admin.ctx,
      {},
      { cursor: aPage.nextCursor ?? undefined, limit: 50 }
    );

    const ids = asB.assignments.map((x) => x.id);
    expect(ids.every((id) => id === forB.id)).toBe(true);
    for (const row of made) expect(ids).not.toContain(row.id);
  });

  it("a forged cursor naming another tenant's row id still only ever yields this tenant's rows", async () => {
    const a = await createScenario();
    const b = await createScenario();
    const foreign = await assign(b, b.course.id);
    const mine = await assign(a, a.course.id);
    const forged = encode({
      createdAt: new Date(Date.now() + 60_000).toISOString(),
      id: foreign.id,
    });

    const page = await listOrgAssignments(a.admin.ctx, {}, { cursor: forged });

    expect(page.assignments.map((x) => x.id)).toEqual([mine.id]);
  });
});

describe("listOrgAssignments — bounds", () => {
  it("a page holds at most the limit and keeps the newest first", async () => {
    const s = await createScenario();
    const courses = await Promise.all(
      Array.from({ length: 4 }, () => createCourseIn(s.tenant.id, s.instructor.user.id))
    );
    const made = [];
    for (const c of courses) made.push(await assign(s, c.course.id));

    const list = await listOrgAssignments(s.admin.ctx, {}, { limit: 3 });

    expect(list.hasMore).toBe(true);
    expect(list.nextCursor).not.toBeNull();
    expect(list.assignments).toHaveLength(3);
    expect(list.assignments.map((x) => x.id)).toEqual([made[3].id, made[2].id, made[1].id]);
  });

  it("never exceeds the hard cap even if asked for more, and defaults to a modest page", async () => {
    const s = await createScenario();
    await assign(s, s.course.id);

    const list = await listOrgAssignments(s.admin.ctx, {}, { limit: 10_000 });

    expect(ADMIN_PAGE_MAX).toBe(200);
    expect(ADMIN_PAGE_SIZE).toBe(50);
    expect(list.hasMore).toBe(false);
  });

  it("issues a fixed number of queries whatever the number of rows", async () => {
    async function measure(n: number) {
      const s = await createScenario();
      const learners = await Promise.all(
        Array.from({ length: n }, () => createUserIn(s.tenant.id, "STUDENT"))
      );
      for (const l of learners) await assign(s, s.course.id, { learnerId: l.user.id });
      const spies = [
        vi.spyOn(db.learningAssignment, "findMany"),
        vi.spyOn(db.enrollment, "findMany"),
        vi.spyOn(db, "$queryRaw"),
      ];
      const list = await listOrgAssignments(s.admin.ctx);
      const calls = spies.map((x) => x.mock.calls.length);
      vi.restoreAllMocks();
      return { calls, count: list.assignments.length };
    }

    const few = await measure(1);
    const many = await measure(15);

    expect(few.count).toBe(1);
    expect(many.count).toBe(15);
    expect(many.calls).toEqual(few.calls);
    // the page's id query and the progress query are raw; the rest are one each
    expect(many.calls).toEqual([1, 1, 2]);
  });

  it("does no follow-up lookups for an empty organisation", async () => {
    const s = await createScenario();
    const enrollments = vi.spyOn(db.enrollment, "findMany");

    expect(await listOrgAssignments(s.admin.ctx)).toEqual({
      assignments: [],
      hasMore: false,
      nextCursor: null,
    });
    expect(enrollments).not.toHaveBeenCalled();
  });
});

describe("listOrgAssignments — authorization", () => {
  it("allows only an ORG_ADMIN with a tenant", async () => {
    const s = await createScenario();
    const superAdmin = await createUserIn(s.tenant.id, "SUPER_ADMIN");

    await expect(listOrgAssignments(s.admin.ctx)).resolves.toBeDefined();
    for (const actor of [s.instructor.ctx, s.learner.ctx, superAdmin.ctx]) {
      await expect(listOrgAssignments(actor), actor.role).rejects.toMatchObject({ status: 403 });
      await expect(listAssignmentOptions(actor), actor.role).rejects.toMatchObject({ status: 403 });
    }
  });

  it("rejects an admin with no organisation with 400", async () => {
    const solo = await createTenantlessStudent();

    await expect(
      listOrgAssignments({
        userId: solo.id,
        clerkId: solo.clerkId,
        tenantId: null,
        role: "ORG_ADMIN",
      })
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("listAssignmentOptions", () => {
  it("offers this tenant's active learners and its own and the catalogue's published free courses", async () => {
    const s = await createScenario();
    const other = await createTenant();
    const otherInstructor = await createUserIn(other.id, "INSTRUCTOR");
    const otherLearner = await createUserIn(other.id, "STUDENT");
    const gone = await createUserIn(s.tenant.id, "STUDENT");
    await db.user.update({ where: { id: gone.user.id }, data: { deletedAt: new Date() } });

    const catalogue = await createCourseIn(null, s.instructor.user.id);
    const draft = await createCourseIn(s.tenant.id, s.instructor.user.id, { status: "DRAFT" });
    const archived = await createCourseIn(s.tenant.id, s.instructor.user.id, {
      status: "ARCHIVED",
    });
    const paid = await createCourseIn(s.tenant.id, s.instructor.user.id, { price: 499 });
    const cataloguePaid = await createCourseIn(null, s.instructor.user.id, { price: 50 });
    const foreign = await createCourseIn(other.id, otherInstructor.user.id);

    const { learners, courses } = await listAssignmentOptions(s.admin.ctx);

    const learnerIds = learners.map((l) => l.id);
    expect(learnerIds).toContain(s.learner.user.id);
    for (const excluded of [
      s.admin.user.id,
      s.instructor.user.id,
      otherLearner.user.id,
      gone.user.id,
    ]) {
      expect(learnerIds, excluded).not.toContain(excluded);
    }

    const courseIds = courses.map((c) => c.id);
    // The organisation's own course is always offered, ahead of the catalogue.
    expect(courseIds[0]).toBe(s.course.id);
    expect(courses.find((c) => c.id === s.course.id)?.isCatalogue).toBe(false);
    for (const excluded of [
      draft.course.id,
      archived.course.id,
      paid.course.id,
      cataloguePaid.course.id,
      foreign.course.id,
    ]) {
      expect(courseIds, excluded).not.toContain(excluded);
    }

    // Whatever catalogue courses are offered (the shared test database holds
    // many, so the cap can apply) are all genuinely open, published and free.
    const offeredCatalogue = courses.filter((c) => c.isCatalogue).map((c) => c.id);
    expect(offeredCatalogue.length).toBeGreaterThan(0);
    const truth = await db.course.findMany({
      where: { id: { in: offeredCatalogue } },
      select: { tenantId: true, status: true, price: true },
    });
    expect(
      truth.every((c) => c.tenantId === null && c.status === "PUBLISHED" && c.price === 0)
    ).toBe(true);
    expect(catalogue.course.id).toBeTruthy();
  });

  it("only exposes what a selector needs", async () => {
    const s = await createScenario();

    const { learners } = await listAssignmentOptions(s.admin.ctx);

    expect(Object.keys(learners[0]).sort()).toEqual(["email", "id", "name"]);
  });
});
