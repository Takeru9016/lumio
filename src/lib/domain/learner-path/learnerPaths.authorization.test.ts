import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { learnerWorld, refusalOf } from "@/lib/domain/learner-path/__test__/learnerWorld";
import {
  getLearningPathForLearner,
  listLearningPathsForLearner,
} from "@/lib/domain/learner-path/learnerPaths";

afterAll(async () => {
  await db.$disconnect();
});

describe("only an active STUDENT of a tenant can read paths", () => {
  it("lets the student through", async () => {
    const w = await learnerWorld();
    const path = await w.publishedPath([await w.make()]);

    expect((await listLearningPathsForLearner(w.learner.ctx)).paths).toHaveLength(1);
    expect((await getLearningPathForLearner(w.learner.ctx, path.id)).id).toBe(path.id);
  });

  it("turns away an instructor, an ORG_ADMIN and a SUPER_ADMIN with 403, whatever they ask for", async () => {
    const w = await learnerWorld();
    const path = await w.publishedPath([await w.make()]);

    for (const [name, ctx] of [
      ["INSTRUCTOR", w.instructor.ctx],
      ["ORG_ADMIN", w.admin.ctx],
      ["SUPER_ADMIN", w.superAdmin.ctx],
    ] as const) {
      expect(await refusalOf(() => listLearningPathsForLearner(ctx)), name).toBe(403);
      expect(await refusalOf(() => getLearningPathForLearner(ctx, path.id)), name).toBe(403);
      expect(await refusalOf(() => getLearningPathForLearner(ctx, "!!")), `${name}, junk id`).toBe(
        403
      );
      expect(
        await refusalOf(() => listLearningPathsForLearner(ctx, { limit: "junk" })),
        `${name}, junk`
      ).toBe(403);
    }
  });

  it("turns away a student with no tenant with 400, the established learner behaviour", async () => {
    const w = await learnerWorld();
    const solo = await db.user.create({
      data: {
        clerkId: `solo-${Date.now()}`,
        email: `solo-${Date.now()}@example.test`,
        role: "STUDENT",
      },
    });
    const ctx = {
      userId: solo.id,
      clerkId: solo.clerkId,
      tenantId: null,
      role: "STUDENT" as const,
    };
    const path = await w.publishedPath([await w.make()]);

    expect(await refusalOf(() => listLearningPathsForLearner(ctx))).toBe(400);
    expect(await refusalOf(() => getLearningPathForLearner(ctx, path.id))).toBe(400);
  });

  it("turns away a student whose account has been deleted", async () => {
    const w = await learnerWorld();
    const path = await w.publishedPath([await w.make()]);
    await db.user.update({ where: { id: w.learner.user.id }, data: { deletedAt: new Date() } });

    expect(await refusalOf(() => listLearningPathsForLearner(w.learner.ctx))).toBe("FORBIDDEN");
    expect(await refusalOf(() => getLearningPathForLearner(w.learner.ctx, path.id))).toBe(
      "FORBIDDEN"
    );
  });

  it("uses the stored identity, not the context's word for it: a session that still says STUDENT after a role change is refused", async () => {
    const w = await learnerWorld();
    const path = await w.publishedPath([await w.make()]);
    await db.user.update({ where: { id: w.learner.user.id }, data: { role: "INSTRUCTOR" } });

    expect(await refusalOf(() => listLearningPathsForLearner(w.learner.ctx))).toBe("FORBIDDEN");
    expect(await refusalOf(() => getLearningPathForLearner(w.learner.ctx, path.id))).toBe(
      "FORBIDDEN"
    );
  });

  it("a session that claims another tenant than the stored one is refused", async () => {
    const w = await learnerWorld();
    const other = await learnerWorld();
    await other.publishedPath([await other.make()]);

    expect(
      await refusalOf(() =>
        listLearningPathsForLearner({ ...w.learner.ctx, tenantId: other.tenant.id })
      )
    ).toBe("FORBIDDEN");
  });
});
