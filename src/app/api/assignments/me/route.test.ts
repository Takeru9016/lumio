import { auth } from "@clerk/nextjs/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  createCourseIn,
  createScenario,
  createTenantlessStudent,
  createUserIn,
} from "@/lib/domain/learning-assignment/__test__/fixtures";
import {
  cancelAssignment,
  createManualAssignment,
} from "@/lib/domain/learning-assignment/assignments";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));

const routeModule = await import("./route");
const { GET } = routeModule;

// The handler takes no request parameter (identity can only come from the
// session). The request is still passed, as Next.js would, to prove the URL is
// never consulted.
const call = (search = "") =>
  (GET as unknown as (req: Request) => Promise<Response>)(
    new Request(`http://localhost/api/assignments/me${search}`)
  );

const signInAs = (clerkId: string | null) =>
  vi.mocked(auth).mockResolvedValue({ userId: clerkId } as never);

async function assign(s: Awaited<ReturnType<typeof createScenario>>, courseId: string, extra = {}) {
  const result = await createManualAssignment(s.admin.ctx, {
    userId: s.learner.user.id,
    courseId,
    ...extra,
  });
  if (!result.ok) throw new Error(`setup failed: ${result.reason}`);
  return result.assignment;
}

afterEach(() => {
  vi.mocked(auth).mockReset();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("GET /api/assignments/me — authentication and authorization", () => {
  it("returns 401 when there is no session", async () => {
    signInAs(null);

    const res = await call();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("returns 401 when the Clerk user has no Lumio user row", async () => {
    signInAs("clerk_user_that_was_never_synced");

    expect((await call()).status).toBe(401);
  });

  it("returns 400 for a learner with no organisation", async () => {
    const solo = await createTenantlessStudent();
    signInAs(solo.clerkId);

    const res = await call();

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "No organisation found" });
  });

  it("returns 403 for an instructor, an org admin and a super admin (the enroll route's learner-only rule)", async () => {
    const s = await createScenario();
    const superAdmin = await createUserIn(s.tenant.id, "SUPER_ADMIN");

    for (const actor of [s.instructor, s.admin, superAdmin]) {
      signInAs(actor.user.clerkId);
      const res = await call();
      expect(res.status, actor.user.role).toBe(403);
      expect(await res.json()).toEqual({ error: "Forbidden" });
    }
  });

  it("exposes only GET", () => {
    const methods = ["POST", "PUT", "PATCH", "DELETE"].filter((m) => m in routeModule);

    expect(methods).toEqual([]);
  });
});

describe("GET /api/assignments/me — reads", () => {
  it("returns the learner's assignments in the documented JSON shape", async () => {
    const s = await createScenario();
    const due = new Date("2027-03-01T23:59:59.999Z");
    const assignment = await assign(s, s.course.id, { dueDate: due });
    signInAs(s.learner.user.clerkId);

    const res = await call();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(Object.keys(body)).toEqual(["assignments"]);
    expect(body.assignments).toEqual([
      {
        id: assignment.id,
        courseId: s.course.id,
        courseTitle: s.course.title,
        courseSlug: s.course.slug,
        source: "MANUAL",
        reason: { assignedByName: s.admin.user.name },
        dueDate: due.toISOString(),
        status: "ASSIGNED",
        createdAt: assignment.createdAt.toISOString(),
      },
    ]);
  });

  it("returns an empty list, not an error, when nothing is assigned", async () => {
    const s = await createScenario();
    signInAs(s.learner.user.clerkId);

    const res = await call();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ assignments: [] });
  });

  it("returns several assignments in a deterministic order with derived statuses", async () => {
    const s = await createScenario();
    const second = await createCourseIn(s.tenant.id, s.instructor.user.id);
    const third = await createCourseIn(s.tenant.id, s.instructor.user.id);
    const later = await assign(s, s.course.id, { dueDate: new Date("2099-01-01T00:00:00.000Z") });
    const overdue = await assign(s, second.course.id, {
      dueDate: new Date("2020-01-01T00:00:00.000Z"),
    });
    const started = await assign(s, third.course.id);
    await db.lessonProgress.create({
      data: { userId: s.learner.user.id, lessonId: third.lesson.id },
    });
    signInAs(s.learner.user.clerkId);

    const first = await (await call()).json();
    const again = await (await call()).json();

    expect(first.assignments.map((a: { id: string }) => a.id)).toEqual([
      overdue.id,
      later.id,
      started.id,
    ]);
    expect(first.assignments.map((a: { status: string }) => a.status)).toEqual([
      "OVERDUE",
      "ASSIGNED",
      "STARTED",
    ]);
    expect(again).toEqual(first);
  });

  it("does not return a cancelled assignment", async () => {
    const s = await createScenario();
    const assignment = await assign(s, s.course.id);
    await cancelAssignment(s.admin.ctx, assignment.id);
    signInAs(s.learner.user.clerkId);

    expect(await (await call()).json()).toEqual({ assignments: [] });
  });

  it("never exposes administrative identifiers in the response body", async () => {
    const s = await createScenario();
    await assign(s, s.course.id, { note: "hello" });
    signInAs(s.learner.user.clerkId);

    const text = await (await call()).text();

    for (const forbidden of [
      "assignedById",
      "cancelledById",
      "tenantId",
      "userId",
      "sourceKey",
      s.admin.user.id,
      s.tenant.id,
    ]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });
});

describe("GET /api/assignments/me — identity comes only from the session", () => {
  it("ignores ?userId= and ?tenantId= and returns the caller's own data", async () => {
    const s = await createScenario();
    const other = await createUserIn(s.tenant.id, "STUDENT");
    const mine = await assign(s, s.course.id);
    const theirs = await createManualAssignment(s.admin.ctx, {
      userId: other.user.id,
      courseId: s.course.id,
    });
    if (!theirs.ok) throw new Error("setup");
    signInAs(s.learner.user.clerkId);

    const res = await call(
      `?userId=${other.user.id}&tenantId=some-other-tenant&user_id=${other.user.id}`
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.assignments.map((a: { id: string }) => a.id)).toEqual([mine.id]);
    expect(JSON.stringify(body)).not.toContain(theirs.assignment.id);
  });

  it("Tenant A's learner never sees Tenant B's assignments, even when Tenant B's ids are supplied", async () => {
    const a = await createScenario();
    const b = await createScenario();
    const bAssignment = await assign(b, b.course.id);
    signInAs(a.learner.user.clerkId);

    const res = await call(`?userId=${b.learner.user.id}&tenantId=${b.tenant.id}`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ assignments: [] });
    expect(JSON.stringify(body)).not.toContain(bAssignment.id);
    expect(JSON.stringify(body)).not.toContain(b.course.title);
  });

  it("Tenant B's learner still sees their own assignment (the isolation is not an accident of empty data)", async () => {
    const a = await createScenario();
    const b = await createScenario();
    const bAssignment = await assign(b, b.course.id);
    signInAs(b.learner.user.clerkId);

    const body = await (await call()).json();

    expect(body.assignments.map((x: { id: string }) => x.id)).toEqual([bAssignment.id]);
    expect(a.tenant.id).not.toBe(b.tenant.id);
  });
});

describe("GET /api/assignments/me — side effects and failure handling", () => {
  it("is read-only: it creates no assignments, enrollments or notifications", async () => {
    const s = await createScenario();
    await assign(s, s.course.id);
    signInAs(s.learner.user.clerkId);
    const snapshot = async () => ({
      assignments: await db.learningAssignment.count(),
      enrollments: await db.enrollment.count({ where: { userId: s.learner.user.id } }),
      notifications: await db.notification.count({ where: { userId: s.learner.user.id } }),
    });
    const before = await snapshot();

    await call();
    await call();

    expect(await snapshot()).toEqual(before);
  });

  it("returns a generic 500 that leaks no database or internal detail", async () => {
    const s = await createScenario();
    signInAs(s.learner.user.clerkId);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(db.learningAssignment, "findMany").mockRejectedValueOnce(
      new Error('relation "LearningAssignment" does not exist at tenant tnt_secret')
    );

    const res = await call();
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: "Failed to load assignments" });
    expect(text).not.toContain("LearningAssignment");
    expect(text).not.toContain("tnt_secret");
  });
});
