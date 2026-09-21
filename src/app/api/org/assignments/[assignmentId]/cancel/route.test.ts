import { auth } from "@clerk/nextjs/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { createScenario, createUserIn } from "@/lib/domain/learning-assignment/__test__/fixtures";
import { createManualAssignment } from "@/lib/domain/learning-assignment/assignments";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));

const routeModule = await import("./route");
const createRoute = await import("../../route");

type Scenario = Awaited<ReturnType<typeof createScenario>>;

const signInAs = (clerkId: string | null) =>
  vi.mocked(auth).mockResolvedValue({ userId: clerkId } as never);

const cancel = (assignmentId: string) =>
  routeModule.POST(
    new Request(`http://localhost/api/org/assignments/${assignmentId}/cancel`, { method: "POST" }),
    {
      params: Promise.resolve({ assignmentId }),
    }
  );

const assignViaApi = (s: Scenario) =>
  createRoute.POST(
    new Request("http://localhost/api/org/assignments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: s.learner.user.id, courseId: s.course.id }),
    })
  );

const row = (id: string) => db.learningAssignment.findUniqueOrThrow({ where: { id } });

async function assigned() {
  const s = await createScenario();
  const result = await createManualAssignment(s.admin.ctx, {
    userId: s.learner.user.id,
    courseId: s.course.id,
  });
  if (!result.ok) throw new Error(`setup failed: ${result.reason}`);
  return { ...s, assignment: result.assignment };
}

afterEach(() => {
  vi.mocked(auth).mockReset();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("authorization matrix — cancel", () => {
  it("unauthenticated: 401", async () => {
    const s = await assigned();
    signInAs(null);

    expect((await cancel(s.assignment.id)).status).toBe(401);
    expect((await row(s.assignment.id)).cancelledAt).toBeNull();
  });

  it("INSTRUCTOR, STUDENT and SUPER_ADMIN: 403, and the assignment is untouched", async () => {
    const s = await assigned();
    const superAdmin = await createUserIn(s.tenant.id, "SUPER_ADMIN");

    for (const clerkId of [
      s.instructor.user.clerkId,
      s.learner.user.clerkId,
      superAdmin.user.clerkId,
    ]) {
      signInAs(clerkId);
      const res = await cancel(s.assignment.id);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Forbidden" });
    }

    const after = await row(s.assignment.id);
    expect(after.cancelledAt).toBeNull();
    expect(after.cancellationCount).toBe(0);
  });

  it("exposes only POST", () => {
    expect(["GET", "PUT", "PATCH", "DELETE"].filter((m) => m in routeModule)).toEqual([]);
  });
});

describe("POST cancel — ORG_ADMIN", () => {
  it("cancels: 200, records who and when, and writes the history", async () => {
    const s = await assigned();
    signInAs(s.admin.user.clerkId);

    const res = await cancel(s.assignment.id);
    const after = await row(s.assignment.id);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "cancelled" });
    expect(after.cancelledAt).not.toBeNull();
    expect(after.cancelledById).toBe(s.admin.user.id);
    expect(after.lastCancelledByName).toBe(s.admin.user.name);
    expect(after.cancellationCount).toBe(1);
  });

  it("is idempotent: cancelling again is 200 'already_cancelled' and adds no history", async () => {
    const s = await assigned();
    signInAs(s.admin.user.clerkId);
    await cancel(s.assignment.id);

    const res = await cancel(s.assignment.id);

    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe("already_cancelled");
    expect((await row(s.assignment.id)).cancellationCount).toBe(1);
  });

  it("keeps the learner enrolled and their progress, evidence and notification intact", async () => {
    const s = await assigned();
    await db.lessonProgress.create({
      data: { userId: s.learner.user.id, lessonId: s.lesson.id, isCompleted: true },
    });
    const before = {
      enrollment: await db.enrollment.findUniqueOrThrow({
        where: { userId_courseId: { userId: s.learner.user.id, courseId: s.course.id } },
      }),
      progress: await db.lessonProgress.count({ where: { userId: s.learner.user.id } }),
      notifications: await db.notification.count({ where: { userId: s.learner.user.id } }),
    };
    signInAs(s.admin.user.clerkId);

    await cancel(s.assignment.id);

    const enrollment = await db.enrollment.findUniqueOrThrow({
      where: { userId_courseId: { userId: s.learner.user.id, courseId: s.course.id } },
    });
    expect(enrollment.status).toBe(before.enrollment.status);
    expect(enrollment.completedAt).toEqual(before.enrollment.completedAt);
    expect(await db.lessonProgress.count({ where: { userId: s.learner.user.id } })).toBe(
      before.progress
    );
    expect(await db.notification.count({ where: { userId: s.learner.user.id } })).toBe(
      before.notifications
    );
    expect(await db.learningAssignment.count({ where: { id: s.assignment.id } })).toBe(1);
  });

  it("refuses a completed assignment with 409 and leaves it, and its history, untouched", async () => {
    const s = await assigned();
    await db.enrollment.update({
      where: { userId_courseId: { userId: s.learner.user.id, courseId: s.course.id } },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    signInAs(s.admin.user.clerkId);

    const res = await cancel(s.assignment.id);
    const after = await row(s.assignment.id);

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/completed/);
    expect(after.cancelledAt).toBeNull();
    expect(after.cancellationCount).toBe(0);
    expect(after.lastCancelledAt).toBeNull();
  });

  it("404 for an unknown assignment and for a malformed id, without a database error", async () => {
    const s = await assigned();
    signInAs(s.admin.user.clerkId);

    for (const id of ["does-not-exist", "a b", "x".repeat(200), "a'b", "a\u0000b"]) {
      const res = await cancel(id);
      expect(res.status, JSON.stringify(id).slice(0, 20)).toBe(404);
      expect(await res.json()).toEqual({ error: "Assignment not found." });
    }
  });
});

describe("POST cancel — tenant isolation", () => {
  it("Tenant A's admin cannot cancel Tenant B's assignment even with its id; it answers as if it did not exist", async () => {
    const a = await createScenario();
    const b = await assigned();
    signInAs(a.admin.user.clerkId);

    const foreign = await cancel(b.assignment.id);
    const unknown = await cancel("does-not-exist");
    const after = await row(b.assignment.id);

    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual(await unknown.json());
    expect(after.cancelledAt).toBeNull();
    expect(after.cancellationCount).toBe(0);
  });

  it("the owning tenant's admin still can", async () => {
    const b = await assigned();
    signInAs(b.admin.user.clerkId);

    expect((await cancel(b.assignment.id)).status).toBe(200);
  });
});

describe("POST cancel — failures never leak internals", () => {
  it("an unexpected failure is a generic 500", async () => {
    const s = await assigned();
    signInAs(s.admin.user.clerkId);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(db, "$transaction").mockRejectedValueOnce(
      new Error('deadlock detected on "Enrollment"')
    );

    const res = await cancel(s.assignment.id);
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({
      error: "Couldn't cancel that assignment. Please try again.",
    });
    expect(text).not.toMatch(/deadlock|Enrollment/);
  });
});

describe("concurrency over HTTP", () => {
  it("six simultaneous cancellations: one 'cancelled', the rest 'already_cancelled', one history record", async () => {
    const s = await assigned();
    signInAs(s.admin.user.clerkId);

    const responses = await Promise.all(Array.from({ length: 6 }, () => cancel(s.assignment.id)));
    const outcomes = await Promise.all(responses.map(async (r) => (await r.json()).outcome));

    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(outcomes.filter((o) => o === "cancelled")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "already_cancelled")).toHaveLength(5);
    expect((await row(s.assignment.id)).cancellationCount).toBe(1);
  });

  it("cancel racing a re-assignment always ends coherent, with one row and its history intact", async () => {
    for (let i = 0; i < 8; i++) {
      const s = await assigned();
      signInAs(s.admin.user.clerkId);
      await cancel(s.assignment.id);

      const [c, r] = await Promise.all([cancel(s.assignment.id), assignViaApi(s)]);
      const after = await row(s.assignment.id);

      expect(c.status, `iteration ${i}`).toBe(200);
      expect([200, 201]).toContain(r.status);
      expect(
        await db.learningAssignment.count({
          where: { userId: s.learner.user.id, courseId: s.course.id },
        })
      ).toBe(1);
      expect(after.lastCancelledAt).not.toBeNull();
      expect(after.cancellationCount).toBeGreaterThanOrEqual(1);
      expect(after.cancellationCount).toBeLessThanOrEqual(2);
      if (after.cancelledAt !== null) {
        expect(after.lastCancelledAt?.getTime()).toBe(after.cancelledAt.getTime());
      }
    }
  });

  it("a completion racing a cancellation is decided by the enrollment lock: the assignment ends completed-and-active, or cancelled-and-not-completed, never both", async () => {
    const s = await assigned();
    signInAs(s.admin.user.clerkId);
    const where = { userId_courseId: { userId: s.learner.user.id, courseId: s.course.id } };

    const [res] = await Promise.all([
      cancel(s.assignment.id),
      db.enrollment.updateMany({
        where: { userId: s.learner.user.id, courseId: s.course.id },
        data: { status: "COMPLETED", completedAt: new Date() },
      }),
    ]);
    const after = await row(s.assignment.id);
    const enrollment = await db.enrollment.findUniqueOrThrow({ where: where });

    if (res.status === 409) {
      expect(after.cancelledAt).toBeNull();
      expect(after.cancellationCount).toBe(0);
    } else {
      expect(res.status).toBe(200);
      expect(after.cancellationCount).toBe(1);
    }
    // Progress and enrollment are never removed by a cancellation.
    expect(enrollment.status).toBe("COMPLETED");
  });
});
