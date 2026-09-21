import { auth } from "@clerk/nextjs/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  createCourseIn,
  createScenario,
  createTenant,
  createUserIn,
} from "@/lib/domain/learning-assignment/__test__/fixtures";
import { listOrgAssignments } from "@/lib/domain/learning-assignment/adminAssignments";
import { cancelAssignment } from "@/lib/domain/learning-assignment/assignments";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));

const routeModule = await import("./route");
const { GET, POST } = routeModule;

type Scenario = Awaited<ReturnType<typeof createScenario>>;

const signInAs = (clerkId: string | null) =>
  vi.mocked(auth).mockResolvedValue({ userId: clerkId } as never);

const post = (body: unknown, raw = false) =>
  POST(
    new Request("http://localhost/api/org/assignments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw ? (body as string) : JSON.stringify(body),
    })
  );

const get = (search = "") => GET(new Request(`http://localhost/api/org/assignments${search}`));

const rows = (userId: string) => db.learningAssignment.findMany({ where: { userId } });

afterEach(() => {
  vi.mocked(auth).mockReset();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

async function actors(s: Scenario) {
  const superAdmin = await createUserIn(s.tenant.id, "SUPER_ADMIN");
  return [
    ["INSTRUCTOR", s.instructor.user.clerkId],
    ["STUDENT", s.learner.user.clerkId],
    ["SUPER_ADMIN", superAdmin.user.clerkId],
  ] as const;
}

describe("authorization matrix — list and create", () => {
  it("unauthenticated: 401 on both", async () => {
    signInAs(null);

    expect((await get()).status).toBe(401);
    expect((await post({})).status).toBe(401);
  });

  it("a Clerk user with no Lumio row: 401", async () => {
    signInAs("clerk_never_synced");

    expect((await get()).status).toBe(401);
    expect((await post({})).status).toBe(401);
  });

  it("INSTRUCTOR, STUDENT and SUPER_ADMIN: 403 on both, and nothing is written", async () => {
    const s = await createScenario();
    const target = await createUserIn(s.tenant.id, "STUDENT");

    for (const [role, clerkId] of await actors(s)) {
      signInAs(clerkId);

      const list = await get();
      const create = await post({ userId: target.user.id, courseId: s.course.id });

      expect(list.status, `${role} list`).toBe(403);
      expect(create.status, `${role} create`).toBe(403);
      expect(await create.json()).toEqual({ error: "Forbidden" });
    }
    expect(await rows(target.user.id)).toEqual([]);
  });

  it("authorization is decided before the input is looked at: a student sending junk still gets 403", async () => {
    const s = await createScenario();
    signInAs(s.learner.user.clerkId);

    expect((await post("not json {", true)).status).toBe(403);
    expect((await get("?status=NONSENSE")).status).toBe(403);
    expect((await get("?cursor=garbage")).status).toBe(403);
  });

  it("an ORG_ADMIN with no organisation: 400", async () => {
    const orphan = await db.user.create({
      data: {
        clerkId: `clerk-orphan-${Date.now()}`,
        email: `orphan-${Date.now()}@x.test`,
        role: "ORG_ADMIN",
      },
    });
    signInAs(orphan.clerkId);

    expect((await get()).status).toBe(400);
    expect((await post({})).status).toBe(400);
  });

  it("exposes only GET and POST", () => {
    const methods = ["PUT", "PATCH", "DELETE"].filter((m) => m in routeModule);

    expect(methods).toEqual([]);
  });
});

describe("POST — ORG_ADMIN creates a manual assignment", () => {
  it("201, and the domain does the work: source, key, tenant and assigner come from the session", async () => {
    const s = await createScenario();
    signInAs(s.admin.user.clerkId);

    const res = await post({ userId: s.learner.user.id, courseId: s.course.id });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body).toEqual({
      outcome: "created",
      status: "ASSIGNED",
      assignment: { id: expect.any(String) },
    });
    const [row] = await rows(s.learner.user.id);
    expect(row).toMatchObject({
      id: body.assignment.id,
      tenantId: s.tenant.id,
      assignedById: s.admin.user.id,
      source: "MANUAL",
      sourceKey: `manual:${s.course.id}`,
      courseId: s.course.id,
    });
    expect(
      await db.enrollment.count({ where: { userId: s.learner.user.id, courseId: s.course.id } })
    ).toBe(1);
    expect(await db.notification.count({ where: { userId: s.learner.user.id } })).toBe(1);
  });

  it("does not return the stored row: no tenant, assigner or source key in the response", async () => {
    const s = await createScenario();
    signInAs(s.admin.user.clerkId);

    const text = await (await post({ userId: s.learner.user.id, courseId: s.course.id })).text();

    for (const forbidden of [
      s.tenant.id,
      s.admin.user.id,
      "sourceKey",
      "assignedById",
      "tenantId",
    ]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it("stores a calendar due date as the end of that day in UTC, and the optional note", async () => {
    const s = await createScenario();
    signInAs(s.admin.user.clerkId);

    await post({
      userId: s.learner.user.id,
      courseId: s.course.id,
      dueDate: "2027-03-01",
      note: "  Before the client session.  ",
    });
    const [row] = await rows(s.learner.user.id);

    expect(row.dueDate?.toISOString()).toBe("2027-03-01T23:59:59.999Z");
    expect(row.reason).toMatchObject({ note: "Before the client session." });
  });

  it("works with no due date and no note", async () => {
    const s = await createScenario();
    signInAs(s.admin.user.clerkId);

    const res = await post({ userId: s.learner.user.id, courseId: s.course.id });
    const [row] = await rows(s.learner.user.id);

    expect(res.status).toBe(201);
    expect(row.dueDate).toBeNull();
    expect(JSON.stringify(row.reason)).not.toContain("note");
  });

  it("a past due date is still accepted and the assignment is simply OVERDUE (L-4 unchanged)", async () => {
    const s = await createScenario();
    signInAs(s.admin.user.clerkId);

    const res = await post({
      userId: s.learner.user.id,
      courseId: s.course.id,
      dueDate: "2020-01-01",
    });

    expect(res.status).toBe(201);
    expect((await res.json()).status).toBe("OVERDUE");
  });

  it("assigns an open-catalogue course that is published and free", async () => {
    const s = await createScenario();
    const catalogue = await createCourseIn(null, s.instructor.user.id);
    signInAs(s.admin.user.clerkId);

    const res = await post({ userId: s.learner.user.id, courseId: catalogue.course.id });

    expect(res.status).toBe(201);
  });
});

describe("POST — duplicates are idempotent, never a second row (28.5.8)", () => {
  it("the second identical request is 200 with outcome 'existing' and changes nothing", async () => {
    const s = await createScenario();
    signInAs(s.admin.user.clerkId);
    const first = await (await post({ userId: s.learner.user.id, courseId: s.course.id })).json();

    const res = await post({ userId: s.learner.user.id, courseId: s.course.id });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.outcome).toBe("existing");
    expect(body.assignment.id).toBe(first.assignment.id);
    expect(await rows(s.learner.user.id)).toHaveLength(1);
    expect(await db.notification.count({ where: { userId: s.learner.user.id } })).toBe(1);
  });

  it("a different due date on an existing assignment reports 'updated' and still one row", async () => {
    const s = await createScenario();
    signInAs(s.admin.user.clerkId);
    await post({ userId: s.learner.user.id, courseId: s.course.id, dueDate: "2027-01-01" });

    const res = await post({
      userId: s.learner.user.id,
      courseId: s.course.id,
      dueDate: "2027-06-01",
    });

    expect((await res.json()).outcome).toBe("updated");
    expect(await rows(s.learner.user.id)).toHaveLength(1);
  });

  it("omitting the due date on a repeat does not clear the existing one", async () => {
    const s = await createScenario();
    signInAs(s.admin.user.clerkId);
    await post({ userId: s.learner.user.id, courseId: s.course.id, dueDate: "2027-01-01" });

    const res = await post({ userId: s.learner.user.id, courseId: s.course.id });
    const [row] = await rows(s.learner.user.id);

    expect((await res.json()).outcome).toBe("existing");
    expect(row.dueDate?.toISOString()).toBe("2027-01-01T23:59:59.999Z");
  });

  it("ten simultaneous identical requests create exactly one assignment", async () => {
    const s = await createScenario();
    signInAs(s.admin.user.clerkId);

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => post({ userId: s.learner.user.id, courseId: s.course.id }))
    );
    const outcomes = await Promise.all(responses.map(async (r) => (await r.json()).outcome));

    expect(responses.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(outcomes.filter((o) => o === "created")).toHaveLength(1);
    expect(await rows(s.learner.user.id)).toHaveLength(1);
    expect(
      await db.enrollment.count({ where: { userId: s.learner.user.id, courseId: s.course.id } })
    ).toBe(1);
    expect(await db.notification.count({ where: { userId: s.learner.user.id } })).toBe(1);
  });

  it("re-assigning a cancelled assignment reactivates the SAME row and keeps its cancellation history", async () => {
    const s = await createScenario();
    signInAs(s.admin.user.clerkId);
    const first = await (await post({ userId: s.learner.user.id, courseId: s.course.id })).json();
    await cancelAssignment(s.admin.ctx, first.assignment.id);

    const res = await post({ userId: s.learner.user.id, courseId: s.course.id });
    const body = await res.json();
    const [row] = await rows(s.learner.user.id);

    expect(res.status).toBe(200);
    expect(body.outcome).toBe("reactivated");
    expect(body.assignment.id).toBe(first.assignment.id);
    expect(await rows(s.learner.user.id)).toHaveLength(1);
    expect(row.cancelledAt).toBeNull();
    expect(row.cancellationCount).toBe(1);
    expect(row.lastCancelledByName).toBe(s.admin.user.name);
  });
});

describe("POST — forged fields are ignored (28.5.6 / 28.5.17)", () => {
  it("tenantId, assignedById, source, sourceKey, reason and cancellation fields in the body change nothing", async () => {
    const s = await createScenario();
    const other = await createScenario();
    signInAs(s.admin.user.clerkId);

    const res = await post({
      userId: s.learner.user.id,
      courseId: s.course.id,
      tenantId: other.tenant.id,
      assignedById: other.admin.user.id,
      source: "CAPABILITY_GAP",
      sourceKey: "gap:forged:forged",
      reason: { assignedByName: "Forged Person" },
      mandatoryTrainingId: "forged",
      cancelledAt: new Date().toISOString(),
      cancelledById: other.admin.user.id,
      id: "forged-id",
    });
    const [row] = await rows(s.learner.user.id);

    expect(res.status).toBe(201);
    expect(row.tenantId).toBe(s.tenant.id);
    expect(row.assignedById).toBe(s.admin.user.id);
    expect(row.source).toBe("MANUAL");
    expect(row.sourceKey).toBe(`manual:${s.course.id}`);
    expect(row.mandatoryTrainingId).toBeNull();
    expect(row.cancelledAt).toBeNull();
    expect(row.id).not.toBe("forged-id");
    expect(JSON.stringify(row.reason)).not.toContain("Forged Person");
    expect(await rows(other.learner.user.id)).toEqual([]);
  });

  it("can never produce a CAPABILITY_GAP or MANDATORY assignment", async () => {
    const s = await createScenario();
    signInAs(s.admin.user.clerkId);

    for (const source of ["CAPABILITY_GAP", "MANDATORY", "manual"]) {
      await post({ userId: s.learner.user.id, courseId: s.course.id, source });
    }

    const stored = await rows(s.learner.user.id);
    expect(stored.map((r) => r.source)).toEqual(["MANUAL"]);
  });
});

describe("POST — tenant isolation, even when the foreign ids are known", () => {
  it("Tenant A's admin cannot assign Tenant B's learner", async () => {
    const a = await createScenario();
    const b = await createScenario();
    signInAs(a.admin.user.clerkId);

    const res = await post({ userId: b.learner.user.id, courseId: a.course.id });

    expect(res.status).toBe(404);
    expect(await rows(b.learner.user.id)).toEqual([]);
    expect(
      await db.enrollment.count({ where: { userId: b.learner.user.id, courseId: a.course.id } })
    ).toBe(0);
    expect(await db.notification.count({ where: { userId: b.learner.user.id } })).toBe(0);
  });

  it("Tenant A's admin cannot assign Tenant B's course", async () => {
    const a = await createScenario();
    const b = await createScenario();
    signInAs(a.admin.user.clerkId);

    const res = await post({ userId: a.learner.user.id, courseId: b.course.id });

    expect(res.status).toBe(404);
    expect(await rows(a.learner.user.id)).toEqual([]);
    expect(
      await db.enrollment.count({ where: { userId: a.learner.user.id, courseId: b.course.id } })
    ).toBe(0);
  });

  it("a foreign learner, a foreign course and an unknown one are indistinguishable to the caller", async () => {
    const a = await createScenario();
    const b = await createScenario();
    signInAs(a.admin.user.clerkId);

    const foreignLearner = await post({ userId: b.learner.user.id, courseId: a.course.id });
    const unknownLearner = await post({ userId: "does-not-exist", courseId: a.course.id });
    const foreignCourse = await post({ userId: a.learner.user.id, courseId: b.course.id });
    const unknownCourse = await post({ userId: a.learner.user.id, courseId: "does-not-exist" });

    expect(await foreignLearner.json()).toEqual(await unknownLearner.json());
    expect(await foreignCourse.json()).toEqual(await unknownCourse.json());
    expect(foreignLearner.status).toBe(unknownLearner.status);
    expect(foreignCourse.status).toBe(unknownCourse.status);
  });

  it("only students can be assigned: an instructor or admin id is refused as if unknown", async () => {
    const s = await createScenario();
    signInAs(s.admin.user.clerkId);

    for (const target of [s.instructor.user.id, s.admin.user.id]) {
      const res = await post({ userId: target, courseId: s.course.id });
      expect(res.status).toBe(404);
    }
  });

  it("a learner who has been deleted cannot be assigned", async () => {
    const s = await createScenario();
    await db.user.update({ where: { id: s.learner.user.id }, data: { deletedAt: new Date() } });
    signInAs(s.admin.user.clerkId);

    expect((await post({ userId: s.learner.user.id, courseId: s.course.id })).status).toBe(404);
  });
});

describe("POST — invalid and inaccessible input", () => {
  it.each([
    ["missing userId", { courseId: "x" }],
    ["missing courseId", { userId: "x" }],
    ["numeric ids", { userId: 1, courseId: 2 }],
    ["an id with a space", { userId: "a b", courseId: "c" }],
    ["an over-long id", { userId: "x".repeat(200), courseId: "c" }],
    ["an array as the body", []],
    ["a string as the body", "hello"],
    ["null", null],
  ])("400 for %s", async (_label, body) => {
    const s = await createScenario();
    signInAs(s.admin.user.clerkId);

    const res = await post(body);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/learner, course, due date and note/);
  });

  it("400 for a body that is not JSON", async () => {
    const s = await createScenario();
    signInAs(s.admin.user.clerkId);

    expect((await post("{not json", true)).status).toBe(400);
  });

  it.each([
    ["an impossible calendar date", "2026-02-31"],
    ["a non-date string", "tomorrow"],
    ["a number", 20270301],
    ["a date beyond the supported range", "2101-01-01"],
    ["a date before the supported range", "1969-12-31"],
  ])("400 for a due date that is %s, and nothing is written", async (_label, dueDate) => {
    const s = await createScenario();
    signInAs(s.admin.user.clerkId);

    const res = await post({ userId: s.learner.user.id, courseId: s.course.id, dueDate });

    expect(res.status).toBe(400);
    expect(await rows(s.learner.user.id)).toEqual([]);
    expect(
      await db.enrollment.count({ where: { userId: s.learner.user.id, courseId: s.course.id } })
    ).toBe(0);
  });

  it.each([
    ["a note over 500 characters", "x".repeat(501)],
    ["a note with a control character", "bad\u0007note"],
    ["a note that is not a string", 42],
  ])("400 for %s, using the domain's validation", async (_label, note) => {
    const s = await createScenario();
    signInAs(s.admin.user.clerkId);

    const res = await post({ userId: s.learner.user.id, courseId: s.course.id, note });

    expect(res.status).toBe(400);
    expect(await rows(s.learner.user.id)).toEqual([]);
  });

  it("accepts a multi-line note of exactly 500 characters", async () => {
    const s = await createScenario();
    signInAs(s.admin.user.clerkId);

    const res = await post({
      userId: s.learner.user.id,
      courseId: s.course.id,
      note: `${"x".repeat(250)}\n${"y".repeat(249)}`,
    });

    expect(res.status).toBe(201);
  });

  it("an unpublished, archived or paid course of the admin's own tenant is 422 with a helpful reason", async () => {
    const s = await createScenario();
    const draft = await createCourseIn(s.tenant.id, s.instructor.user.id, { status: "DRAFT" });
    const archived = await createCourseIn(s.tenant.id, s.instructor.user.id, {
      status: "ARCHIVED",
    });
    const paid = await createCourseIn(s.tenant.id, s.instructor.user.id, { price: 499 });
    signInAs(s.admin.user.clerkId);

    const results = await Promise.all(
      [draft, archived, paid].map(({ course }) =>
        post({ userId: s.learner.user.id, courseId: course.id })
      )
    );

    expect(results.map((r) => r.status)).toEqual([422, 422, 422]);
    expect((await results[0].json()).error).toMatch(/isn't published/);
    expect((await results[2].json()).error).toMatch(/Paid courses/);
    expect(await rows(s.learner.user.id)).toEqual([]);
  });

  it("a non-assignable open-catalogue course is indistinguishable from a missing one", async () => {
    const s = await createScenario();
    const draft = await createCourseIn(null, s.instructor.user.id, { status: "DRAFT" });
    signInAs(s.admin.user.clerkId);

    const res = await post({ userId: s.learner.user.id, courseId: draft.course.id });
    const missing = await post({ userId: s.learner.user.id, courseId: "does-not-exist" });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(await missing.json());
  });

  it("a learner whose access was refunded is not silently re-enrolled: 409", async () => {
    const s = await createScenario();
    await db.enrollment.create({
      data: { userId: s.learner.user.id, courseId: s.course.id, status: "REFUNDED" },
    });
    signInAs(s.admin.user.clerkId);

    const res = await post({ userId: s.learner.user.id, courseId: s.course.id });

    expect(res.status).toBe(409);
    expect(await rows(s.learner.user.id)).toEqual([]);
  });
});

describe("POST — failures never leak internals", () => {
  it("an unexpected database failure is a generic 500 that names no table, constraint or tenant", async () => {
    const s = await createScenario();
    signInAs(s.admin.user.clerkId);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(db, "$transaction").mockRejectedValueOnce(
      new Error(
        `Unique constraint failed on "LearningAssignment_userId_courseId_source_sourceKey_key" tenant ${s.tenant.id}`
      )
    );

    const res = await post({ userId: s.learner.user.id, courseId: s.course.id });
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: "Couldn't assign that course. Please try again." });
    expect(text).not.toMatch(/constraint|LearningAssignment|tenant|prisma/i);
  });
});

describe("GET — ORG_ADMIN lists the organisation's assignments", () => {
  it("returns the tenant's assignments, cancelled ones included, in the documented shape", async () => {
    const s = await createScenario();
    const second = await createCourseIn(s.tenant.id, s.instructor.user.id);
    signInAs(s.admin.user.clerkId);
    const a = await (
      await post({ userId: s.learner.user.id, courseId: s.course.id, dueDate: "2027-03-01" })
    ).json();
    const b = await (await post({ userId: s.learner.user.id, courseId: second.course.id })).json();
    await cancelAssignment(s.admin.ctx, b.assignment.id);

    const res = await get();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["assignments", "hasMore", "nextCursor"]);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
    expect(body.assignments.map((x: { id: string }) => x.id)).toEqual([
      b.assignment.id,
      a.assignment.id,
    ]);
    expect(body.assignments[0]).toMatchObject({
      status: "CANCELLED",
      source: "MANUAL",
      learner: { email: s.learner.user.email },
      cancellation: { byName: s.admin.user.name },
    });
    expect(body.assignments[1]).toMatchObject({
      status: "ASSIGNED",
      dueDate: "2027-03-01T23:59:59.999Z",
      reason: { kind: "MANUAL", assignedByName: s.admin.user.name },
    });
  });

  it("an empty organisation gets an empty list, not an error", async () => {
    const s = await createScenario();
    signInAs(s.admin.user.clerkId);

    const res = await get();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ assignments: [], hasMore: false, nextCursor: null });
  });

  it("filters by source and status", async () => {
    const s = await createScenario();
    const second = await createCourseIn(s.tenant.id, s.instructor.user.id);
    signInAs(s.admin.user.clerkId);
    await post({ userId: s.learner.user.id, courseId: s.course.id, dueDate: "2020-01-01" });
    const b = await (await post({ userId: s.learner.user.id, courseId: second.course.id })).json();
    await cancelAssignment(s.admin.ctx, b.assignment.id);

    const overdue = await (await get("?status=overdue")).json();
    const cancelled = await (await get("?status=CANCELLED")).json();
    const mandatory = await (await get("?source=MANDATORY")).json();
    const all = await (await get("?source=all&status=all")).json();

    expect(overdue.assignments).toHaveLength(1);
    expect(overdue.assignments[0].status).toBe("OVERDUE");
    expect(cancelled.assignments.map((x: { id: string }) => x.id)).toEqual([b.assignment.id]);
    expect(mandatory.assignments).toEqual([]);
    expect(all.assignments).toHaveLength(2);
  });

  it("a status filter finds old matching rows behind newer non-matching ones", async () => {
    const s = await createScenario();
    signInAs(s.admin.user.clerkId);
    const overdue: string[] = [];
    for (let i = 0; i < 3; i++) {
      const learner = await createUserIn(s.tenant.id, "STUDENT");
      const made = await (
        await post({ userId: learner.user.id, courseId: s.course.id, dueDate: "2020-01-01" })
      ).json();
      overdue.push(made.assignment.id);
    }
    for (let i = 0; i < 4; i++) {
      const learner = await createUserIn(s.tenant.id, "STUDENT");
      await post({ userId: learner.user.id, courseId: s.course.id, dueDate: "2099-01-01" });
    }

    const res = await get("?status=overdue");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.assignments.map((x: { id: string }) => x.id).sort()).toEqual([...overdue].sort());
    expect(body.hasMore).toBe(false);
    expect((await (await get()).json()).assignments).toHaveLength(7);
  });

  it("a 'nextCursor' round-trips through the query string", async () => {
    const s = await createScenario();
    signInAs(s.admin.user.clerkId);
    for (let i = 0; i < 3; i++) {
      const learner = await createUserIn(s.tenant.id, "STUDENT");
      await post({ userId: learner.user.id, courseId: s.course.id });
    }
    const page = await listOrgAssignments(s.admin.ctx, {}, { limit: 2 });
    expect(page.nextCursor).not.toBeNull();

    const res = await get(`?cursor=${encodeURIComponent(page.nextCursor ?? "")}`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.assignments).toHaveLength(1);
    expect(body.hasMore).toBe(false);
  });

  it.each(["?cursor=garbage", "?cursor=e30%3D"])(
    "a malformed cursor (%s) is a 400, not the first page",
    async (search) => {
      const s = await createScenario();
      signInAs(s.admin.user.clerkId);
      const res = await get(search);

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid cursor" });
    }
  );

  it.each(["?status=NONSENSE", "?source=TEAM", "?status=ASSIGNED&source=x"])(
    "an unknown filter (%s) is a 400, not a silently unfiltered list",
    async (search) => {
      const s = await createScenario();
      signInAs(s.admin.user.clerkId);

      expect((await get(search)).status).toBe(400);
    }
  );

  it("shows Tenant A's assignments to A and never Tenant B's, even with B's ids in the URL", async () => {
    const a = await createScenario();
    const b = await createScenario();
    signInAs(a.admin.user.clerkId);
    await post({ userId: a.learner.user.id, courseId: a.course.id });
    signInAs(b.admin.user.clerkId);
    const forB = await (await post({ userId: b.learner.user.id, courseId: b.course.id })).json();

    signInAs(a.admin.user.clerkId);
    const res = await get(
      `?tenantId=${b.tenant.id}&userId=${b.learner.user.id}&courseId=${b.course.id}&tenant=${b.tenant.id}`
    );
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(JSON.parse(text).assignments).toHaveLength(1);
    expect(text).not.toContain(forB.assignment.id);
    expect(text).not.toContain(b.course.title);
    expect(text).not.toContain(b.learner.user.email);
  });

  it("never exposes user, course, tenant or assigner ids or the source key", async () => {
    const s = await createScenario();
    signInAs(s.admin.user.clerkId);
    await post({ userId: s.learner.user.id, courseId: s.course.id, note: "hi" });

    const text = await (await get()).text();

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

  it("is read-only: listing creates and changes nothing", async () => {
    const s = await createScenario();
    signInAs(s.admin.user.clerkId);
    await post({ userId: s.learner.user.id, courseId: s.course.id });
    const snapshot = async () => ({
      assignments: await db.learningAssignment.count(),
      enrollments: await db.enrollment.count({ where: { userId: s.learner.user.id } }),
      notifications: await db.notification.count({ where: { userId: s.learner.user.id } }),
    });
    const before = await snapshot();

    await get();
    await get("?status=ASSIGNED");

    expect(await snapshot()).toEqual(before);
  });

  it("a failure is a generic 500", async () => {
    const s = await createScenario();
    signInAs(s.admin.user.clerkId);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(db, "$queryRaw").mockRejectedValueOnce(
      new Error('relation "LearningAssignment" does not exist')
    );

    const res = await get();
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: "Failed to load assignments" });
    expect(text).not.toContain("LearningAssignment");
  });
});

describe("tenant helper sanity", () => {
  it("scenarios really are different tenants (the isolation tests above are not vacuous)", async () => {
    const a = await createScenario();
    const b = await createScenario();
    const t = await createTenant();

    expect(new Set([a.tenant.id, b.tenant.id, t.id]).size).toBe(3);
  });
});
