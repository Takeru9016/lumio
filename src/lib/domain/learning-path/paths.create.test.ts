import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { errorCodeOf, pathWorld } from "@/lib/domain/learning-path/__test__/pathWorld";
import {
  LEARNING_PATH_DESCRIPTION_MAX_LENGTH,
  LEARNING_PATH_TITLE_MAX_LENGTH,
} from "@/lib/domain/learning-path/constants";
import { createLearningPath } from "@/lib/domain/learning-path/paths";

afterAll(async () => {
  await db.$disconnect();
});

describe("createLearningPath", () => {
  it("creates an empty DRAFT owned by the caller's tenant and created by the caller", async () => {
    const w = await pathWorld();

    const path = await createLearningPath(w.admin.ctx, {
      title: "  Onboarding  ",
      description: "  Week one  ",
    });

    expect(path).toMatchObject({
      title: "Onboarding",
      description: "Week one",
      status: "DRAFT",
      publishedAt: null,
      courseCount: 0,
    });
    const row = await db.learningPath.findUniqueOrThrow({ where: { id: path.id } });
    expect(row).toMatchObject({
      tenantId: w.tenant.id,
      createdById: w.admin.user.id,
      status: "DRAFT",
      publishedAt: null,
    });
    expect(await w.members(path.id)).toEqual([]);
  });

  it("takes no description: it is stored as null", async () => {
    const w = await pathWorld();

    expect((await createLearningPath(w.admin.ctx, { title: "T" })).description).toBeNull();
    expect(
      (await createLearningPath(w.admin.ctx, { title: "T", description: "   " })).description
    ).toBeNull();
  });

  it("returns only the summary: no tenant, no creator", async () => {
    const w = await pathWorld();

    const path = await createLearningPath(w.admin.ctx, { title: "T" });

    expect(Object.keys(path).sort()).toEqual([
      "courseCount",
      "createdAt",
      "description",
      "id",
      "publishedAt",
      "status",
      "title",
      "updatedAt",
    ]);
  });

  it.each([
    ["tenantId", "someone-else"],
    ["createdById", "someone-else"],
    ["status", "PUBLISHED"],
    ["publishedAt", "2026-01-01T00:00:00.000Z"],
    ["id", "chosen-id"],
    ["position", 1],
    ["courses", []],
    ["mystery", true],
  ])("refuses a forged %s and creates nothing", async (key, value) => {
    const w = await pathWorld();
    const foreign = await pathWorld();
    const before = await db.learningPath.count();

    const code = await errorCodeOf(() =>
      createLearningPath(w.admin.ctx, {
        title: "T",
        [key]: key === "tenantId" ? foreign.tenant.id : value,
      })
    );

    expect(code).toBe("INVALID_INPUT");
    expect(await db.learningPath.count()).toBe(before);
    expect(await db.learningPath.count({ where: { tenantId: foreign.tenant.id } })).toBe(0);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["blank", "   "],
    ["a number", 5],
    ["over the limit", "x".repeat(LEARNING_PATH_TITLE_MAX_LENGTH + 1)],
    ["with a line break", "a\nb"],
    ["with a NUL", "a\u0000b"],
  ])("refuses a title that is %s", async (_name, title) => {
    const w = await pathWorld();

    expect(await errorCodeOf(() => createLearningPath(w.admin.ctx, { title }))).toBe(
      "INVALID_INPUT"
    );
  });

  it("accepts the longest title and the longest description, and refuses one more", async () => {
    const w = await pathWorld();

    const ok = await createLearningPath(w.admin.ctx, {
      title: "t".repeat(LEARNING_PATH_TITLE_MAX_LENGTH),
      description: "d".repeat(LEARNING_PATH_DESCRIPTION_MAX_LENGTH),
    });
    expect(ok.title).toHaveLength(LEARNING_PATH_TITLE_MAX_LENGTH);
    expect(ok.description).toHaveLength(LEARNING_PATH_DESCRIPTION_MAX_LENGTH);

    expect(
      await errorCodeOf(() =>
        createLearningPath(w.admin.ctx, {
          title: "T",
          description: "d".repeat(LEARNING_PATH_DESCRIPTION_MAX_LENGTH + 1),
        })
      )
    ).toBe("INVALID_INPUT");
  });

  it.each([
    ["not a string", 5],
    ["with a NUL", "a\u0000b"],
  ])("refuses a description that is %s", async (_name, description) => {
    const w = await pathWorld();

    expect(
      await errorCodeOf(() => createLearningPath(w.admin.ctx, { title: "T", description }))
    ).toBe("INVALID_INPUT");
  });

  it.each([null, undefined, "a string", 5, []])("refuses a body that is %j", async (body) => {
    const w = await pathWorld();

    expect(await errorCodeOf(() => createLearningPath(w.admin.ctx, body))).toBe("INVALID_INPUT");
  });

  it("refuses everyone who is not an ORG_ADMIN of a tenant, before reading the body, and creates nothing", async () => {
    const w = await pathWorld();
    const before = await db.learningPath.count();

    for (const [name, ctx] of w.outsiders) {
      expect(await errorCodeOf(() => createLearningPath(ctx, { title: "T" })), name).toBe(
        "FORBIDDEN"
      );
      expect(await errorCodeOf(() => createLearningPath(ctx, { nonsense: 1 })), name).toBe(
        "FORBIDDEN"
      );
    }
    expect(await db.learningPath.count()).toBe(before);
  });
});
