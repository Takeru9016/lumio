import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createScenario, createUserIn } from "@/lib/domain/learning-assignment/__test__/fixtures";
import {
  cancelAssignment,
  createManualAssignment,
} from "@/lib/domain/learning-assignment/assignments";
import { getLearnerAssignments } from "@/lib/domain/learning-assignment/learnerAssignments";

afterAll(async () => {
  await db.$disconnect();
});

/**
 * M-2. `cancelledAt` / `cancelledById` are the CURRENT state: set while the
 * assignment is cancelled, cleared by reactivation. The `lastCancelled*` fields
 * and `cancellationCount` are the HISTORY: written when a cancellation actually
 * happens, never cleared by reactivation, overwritten only by a later
 * cancellation. The actor is snapshotted (id and name) so it outlives the admin.
 */
async function assigned() {
  const s = await createScenario();
  const result = await createManualAssignment(s.admin.ctx, {
    userId: s.learner.user.id,
    courseId: s.course.id,
  });
  if (!result.ok) throw new Error(`setup failed: ${result.reason}`);
  return { ...s, assignment: result.assignment };
}

const row = (id: string) => db.learningAssignment.findUniqueOrThrow({ where: { id } });

async function reassign(s: Awaited<ReturnType<typeof assigned>>, admin = s.admin) {
  return createManualAssignment(admin.ctx, { userId: s.learner.user.id, courseId: s.course.id });
}

describe("M-2 — a fresh assignment has no history", () => {
  it("starts with no cancellation history and a count of zero", async () => {
    const { assignment } = await assigned();

    expect(assignment.cancelledAt).toBeNull();
    expect(assignment.lastCancelledAt).toBeNull();
    expect(assignment.lastCancelledById).toBeNull();
    expect(assignment.lastCancelledByName).toBeNull();
    expect(assignment.cancellationCount).toBe(0);
  });
});

describe("M-2 — cancelling records the history alongside the current state", () => {
  it("records when, who (id and name) and the count, and mirrors the current state while cancelled", async () => {
    const { admin, assignment } = await assigned();

    await cancelAssignment(admin.ctx, assignment.id);
    const after = await row(assignment.id);

    expect(after.cancelledAt).not.toBeNull();
    expect(after.cancelledById).toBe(admin.user.id);
    expect(after.lastCancelledAt?.getTime()).toBe(after.cancelledAt?.getTime());
    expect(after.lastCancelledById).toBe(admin.user.id);
    expect(after.lastCancelledByName).toBe(admin.user.name);
    expect(after.cancellationCount).toBe(1);
  });

  it("the result of cancelAssignment carries the history too", async () => {
    const { admin, assignment } = await assigned();

    const result = await cancelAssignment(admin.ctx, assignment.id);

    expect(result.ok && result.assignment.cancellationCount).toBe(1);
    expect(result.ok && result.assignment.lastCancelledByName).toBe(admin.user.name);
  });
});

describe("M-2 — reactivation clears the current state and keeps the history", () => {
  it("cancelledAt and cancelledById are cleared; who, when and how many survive", async () => {
    const s = await assigned();
    await cancelAssignment(s.admin.ctx, s.assignment.id);
    const cancelled = await row(s.assignment.id);

    const result = await reassign(s);
    const after = await row(s.assignment.id);

    expect(result.ok && result.outcome).toBe("reactivated");
    expect(after.cancelledAt).toBeNull();
    expect(after.cancelledById).toBeNull();
    expect(after.lastCancelledAt?.getTime()).toBe(cancelled.cancelledAt?.getTime());
    expect(after.lastCancelledById).toBe(s.admin.user.id);
    expect(after.lastCancelledByName).toBe(s.admin.user.name);
    expect(after.cancellationCount).toBe(1);
  });

  it("is the same row: identity, provenance, assigner and creation time are untouched, and no second row appears", async () => {
    const s = await assigned();
    const original = await row(s.assignment.id);
    await cancelAssignment(s.admin.ctx, s.assignment.id);

    await reassign(s);
    const after = await row(s.assignment.id);

    expect(after.id).toBe(original.id);
    expect(after.reason).toEqual(original.reason);
    expect(after.assignedById).toBe(original.assignedById);
    expect(after.createdAt.getTime()).toBe(original.createdAt.getTime());
    expect(after.sourceKey).toBe(original.sourceKey);
    expect(
      await db.learningAssignment.count({
        where: { userId: s.learner.user.id, courseId: s.course.id },
      })
    ).toBe(1);
  });

  it("does not change what status derivation or the learner read see: active again, visible again", async () => {
    const s = await assigned();
    await cancelAssignment(s.admin.ctx, s.assignment.id);
    expect(await getLearnerAssignments(s.learner.ctx)).toEqual([]);

    await reassign(s);
    const visible = await getLearnerAssignments(s.learner.ctx);

    expect(visible).toHaveLength(1);
    expect(visible[0].status).toBe("ASSIGNED");
    expect(JSON.stringify(visible)).not.toMatch(/lastCancelled|cancellationCount/);
  });

  it("a learner-facing read never carries cancellation history, even for a row that has some", async () => {
    const s = await assigned();
    const canceller = await createUserIn(s.tenant.id, "ORG_ADMIN");
    await cancelAssignment(canceller.ctx, s.assignment.id);
    await reassign(s);

    const text = JSON.stringify(await getLearnerAssignments(s.learner.ctx));

    expect(text).not.toContain(canceller.user.name ?? "no-name");
    expect(text).not.toContain(canceller.user.id);
    expect(text).not.toMatch(/cancel/i);
  });
});

describe("M-2 — a second cancellation overwrites the last cancellation and increments the count", () => {
  it("keeps the latest actor and time, and counts both cancellations", async () => {
    const s = await assigned();
    const secondAdmin = await createUserIn(s.tenant.id, "ORG_ADMIN");
    await cancelAssignment(s.admin.ctx, s.assignment.id);
    const firstCancellation = await row(s.assignment.id);
    await reassign(s);
    await new Promise((resolve) => setTimeout(resolve, 5));

    await cancelAssignment(secondAdmin.ctx, s.assignment.id);
    const after = await row(s.assignment.id);

    expect(after.cancellationCount).toBe(2);
    expect(after.lastCancelledById).toBe(secondAdmin.user.id);
    expect(after.lastCancelledByName).toBe(secondAdmin.user.name);
    expect(after.cancelledById).toBe(secondAdmin.user.id);
    // The history holds the SECOND cancellation's time, and the current state is that same instant.
    expect(after.lastCancelledAt?.getTime()).toBeGreaterThan(
      firstCancellation.lastCancelledAt?.getTime() ?? Number.POSITIVE_INFINITY
    );
    expect(after.cancelledAt?.getTime()).toBe(after.lastCancelledAt?.getTime());
  });

  it("re-cancelling an already cancelled assignment changes nothing, not even the count", async () => {
    const s = await assigned();
    const other = await createUserIn(s.tenant.id, "ORG_ADMIN");
    await cancelAssignment(s.admin.ctx, s.assignment.id);
    const first = await row(s.assignment.id);

    const again = await cancelAssignment(other.ctx, s.assignment.id);
    const after = await row(s.assignment.id);

    expect(again.ok && again.outcome).toBe("already_cancelled");
    expect(after.cancellationCount).toBe(1);
    expect(after.lastCancelledById).toBe(s.admin.user.id);
    expect(after.lastCancelledAt?.getTime()).toBe(first.lastCancelledAt?.getTime());
  });
});

describe("M-2 — the actor is a snapshot, not a live reference", () => {
  it("still says who cancelled after that admin's account is removed", async () => {
    const s = await assigned();
    const leaver = await createUserIn(s.tenant.id, "ORG_ADMIN");
    await cancelAssignment(leaver.ctx, s.assignment.id);

    await db.user.delete({ where: { id: leaver.user.id } });
    const after = await row(s.assignment.id);

    // cancelledBy is ON DELETE SET NULL, so the current-state id is gone ...
    expect(after.cancelledById).toBeNull();
    // ... but the history snapshot is not.
    expect(after.lastCancelledByName).toBe(leaver.user.name);
    expect(after.lastCancelledById).toBe(leaver.user.id);
    expect(after.cancellationCount).toBe(1);
  });
});

describe("M-2 — cancellations that do not happen write no history", () => {
  it("a completed assignment cannot be cancelled and gains no history", async () => {
    const s = await assigned();
    await db.enrollment.update({
      where: { userId_courseId: { userId: s.learner.user.id, courseId: s.course.id } },
      data: { status: "COMPLETED", completedAt: new Date() },
    });

    const result = await cancelAssignment(s.admin.ctx, s.assignment.id);
    const after = await row(s.assignment.id);

    expect(result).toEqual({ ok: false, reason: "ASSIGNMENT_COMPLETED" });
    expect(after.cancellationCount).toBe(0);
    expect(after.lastCancelledAt).toBeNull();
    expect(after.lastCancelledById).toBeNull();
    expect(after.lastCancelledByName).toBeNull();
  });

  it("another tenant's admin cannot cancel it and leaves no history", async () => {
    const s = await assigned();
    const foreign = await createScenario();

    const result = await cancelAssignment(foreign.admin.ctx, s.assignment.id);

    expect(result).toEqual({ ok: false, reason: "ASSIGNMENT_NOT_FOUND" });
    expect((await row(s.assignment.id)).cancellationCount).toBe(0);
  });
});

describe("M-2 — concurrency", () => {
  it("many simultaneous cancellations write exactly one history record", async () => {
    const s = await assigned();
    const admins = await Promise.all(
      Array.from({ length: 8 }, () => createUserIn(s.tenant.id, "ORG_ADMIN"))
    );

    const results = await Promise.all(admins.map((a) => cancelAssignment(a.ctx, s.assignment.id)));
    const after = await row(s.assignment.id);

    expect(results.filter((r) => r.ok && r.outcome === "cancelled")).toHaveLength(1);
    expect(after.cancellationCount).toBe(1);
    expect(admins.map((a) => a.user.id)).toContain(after.lastCancelledById);
    expect(after.lastCancelledById).toBe(after.cancelledById);
  });

  it("cancel racing reactivation always ends in a coherent state, with history intact", async () => {
    for (let i = 0; i < 12; i++) {
      const s = await assigned();
      await cancelAssignment(s.admin.ctx, s.assignment.id);
      const before = await row(s.assignment.id);

      const [cancel, reactivate] = await Promise.all([
        cancelAssignment(s.admin.ctx, s.assignment.id),
        reassign(s),
      ]);
      const after = await row(s.assignment.id);

      expect(cancel.ok, `iteration ${i}`).toBe(true);
      expect(reactivate.ok, `iteration ${i}`).toBe(true);
      // Exactly one row throughout.
      expect(
        await db.learningAssignment.count({
          where: { userId: s.learner.user.id, courseId: s.course.id },
        })
      ).toBe(1);
      // History never goes backwards and never disagrees with the current state.
      expect(after.cancellationCount).toBeGreaterThanOrEqual(before.cancellationCount);
      expect(after.cancellationCount).toBeLessThanOrEqual(before.cancellationCount + 1);
      expect(after.lastCancelledAt).not.toBeNull();
      expect(after.lastCancelledById).toBe(s.admin.user.id);
      if (after.cancelledAt !== null) {
        expect(after.cancelledById).toBe(s.admin.user.id);
        expect(after.lastCancelledAt?.getTime()).toBe(after.cancelledAt.getTime());
      }
    }
  });

  it("cancel racing a fresh re-assignment of an active assignment is coherent too", async () => {
    for (let i = 0; i < 12; i++) {
      const s = await assigned();

      await Promise.all([cancelAssignment(s.admin.ctx, s.assignment.id), reassign(s)]);
      const after = await row(s.assignment.id);

      expect(
        await db.learningAssignment.count({
          where: { userId: s.learner.user.id, courseId: s.course.id },
        })
      ).toBe(1);
      // Either the cancellation landed last (cancelled, count 1) or the
      // re-assignment reactivated it (active, count 1); never a count of 2 and
      // never a current state without its history.
      expect(after.cancellationCount, `iteration ${i}`).toBeLessThanOrEqual(1);
      if (after.cancelledAt !== null) {
        expect(after.cancellationCount).toBe(1);
        expect(after.lastCancelledAt?.getTime()).toBe(after.cancelledAt.getTime());
      }
      if (after.cancellationCount === 1) expect(after.lastCancelledAt).not.toBeNull();
    }
  });
});
