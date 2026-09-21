import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { errorCodeOf, pathWorld } from "@/lib/domain/learning-path/__test__/pathWorld";
import { updateLearningPath } from "@/lib/domain/learning-path/paths";
import { assessPublishability } from "@/lib/domain/learning-path/publishability";

afterAll(async () => {
  await db.$disconnect();
});

const row = (id: string) => db.learningPath.findUniqueOrThrow({ where: { id } });

describe("updateLearningPath", () => {
  it("edits the title and the description of a DRAFT, keeping its status and courses", async () => {
    const w = await pathWorld();
    const course = await w.make();
    const path = await w.makePath({ title: "Old", courses: [course] });

    const updated = await updateLearningPath(w.admin.ctx, path.id, {
      title: " New ",
      description: "About",
    });

    expect(updated).toMatchObject({
      id: path.id,
      title: "New",
      description: "About",
      status: "DRAFT",
      courseCount: 1,
    });
    expect(await w.memberIds(path.id)).toEqual([course.id]);
  });

  it("changes only the field it is given", async () => {
    const w = await pathWorld();
    const path = await w.makePath({ title: "Keep" });
    await db.learningPath.update({ where: { id: path.id }, data: { description: "Also keep" } });

    await updateLearningPath(w.admin.ctx, path.id, { title: "Changed" });
    expect(await row(path.id)).toMatchObject({ title: "Changed", description: "Also keep" });

    await updateLearningPath(w.admin.ctx, path.id, { description: "Changed too" });
    expect(await row(path.id)).toMatchObject({ title: "Changed", description: "Changed too" });
  });

  it("clears the description with null or blank", async () => {
    const w = await pathWorld();
    const path = await w.makePath();
    await db.learningPath.update({ where: { id: path.id }, data: { description: "Text" } });

    await updateLearningPath(w.admin.ctx, path.id, { description: null });
    expect((await row(path.id)).description).toBeNull();

    await db.learningPath.update({ where: { id: path.id }, data: { description: "Text" } });
    await updateLearningPath(w.admin.ctx, path.id, { description: "  " });
    expect((await row(path.id)).description).toBeNull();
  });

  it("edits a PUBLISHED path, which stays PUBLISHED, keeps its publishedAt and stays publishable", async () => {
    const w = await pathWorld();
    const course = await w.make();
    const path = await w.makePath({ status: "PUBLISHED", courses: [course] });
    const before = await row(path.id);

    const updated = await updateLearningPath(w.admin.ctx, path.id, { title: "Renamed" });

    expect(updated).toMatchObject({ status: "PUBLISHED", title: "Renamed" });
    expect((await row(path.id)).publishedAt).toEqual(before.publishedAt);
    expect(
      assessPublishability({
        title: updated.title,
        tenantId: w.tenant.id,
        courses: [
          {
            id: course.id,
            title: course.title,
            tenantId: w.tenant.id,
            status: "PUBLISHED",
            hasPublishedLesson: true,
          },
        ],
      }).publishable
    ).toBe(true);
  });

  it("refuses a title that would make a published path unpublishable, and changes nothing", async () => {
    const w = await pathWorld();
    const path = await w.makePath({
      status: "PUBLISHED",
      title: "Fine",
      courses: [await w.make()],
    });

    for (const title of ["", "   ", "x".repeat(101)]) {
      expect(await errorCodeOf(() => updateLearningPath(w.admin.ctx, path.id, { title }))).toBe(
        "INVALID_INPUT"
      );
    }
    expect((await row(path.id)).title).toBe("Fine");
  });

  it("refuses an ARCHIVED path with PATH_ARCHIVED and does not reactivate it", async () => {
    const w = await pathWorld();
    const path = await w.makePath({ status: "ARCHIVED", title: "Frozen" });

    const code = await errorCodeOf(() => updateLearningPath(w.admin.ctx, path.id, { title: "X" }));

    expect(code).toBe("PATH_ARCHIVED");
    expect(await row(path.id)).toMatchObject({ status: "ARCHIVED", title: "Frozen" });
  });

  it("another tenant's path, an unknown path and a malformed id are all NOT_FOUND, and the other tenant's path is untouched", async () => {
    const w = await pathWorld();
    const other = await pathWorld();
    const theirs = await other.makePath({ title: "Theirs" });

    for (const id of [theirs.id, "does-not-exist", "bad id!", "", 5, null]) {
      expect(await errorCodeOf(() => updateLearningPath(w.admin.ctx, id, { title: "X" }))).toBe(
        "NOT_FOUND"
      );
    }
    expect((await row(theirs.id)).title).toBe("Theirs");
  });

  it.each([
    ["tenantId"],
    ["createdById"],
    ["status"],
    ["publishedAt"],
    ["id"],
    ["courses"],
    ["position"],
    ["mystery"],
  ])("refuses a forged %s and changes nothing", async (key) => {
    const w = await pathWorld();
    const path = await w.makePath({ title: "Same" });

    const code = await errorCodeOf(() =>
      updateLearningPath(w.admin.ctx, path.id, { title: "Changed", [key]: "ARCHIVED" })
    );

    expect(code).toBe("INVALID_INPUT");
    expect(await row(path.id)).toMatchObject({ title: "Same", status: "DRAFT" });
  });

  it.each([{}, null, "text", [], { title: 5 }, { title: "" }, { description: 5 }])(
    "refuses the body %j",
    async (body) => {
      const w = await pathWorld();
      const path = await w.makePath();

      expect(await errorCodeOf(() => updateLearningPath(w.admin.ctx, path.id, body))).toBe(
        "INVALID_INPUT"
      );
    }
  );

  it("refuses everyone who is not an ORG_ADMIN of a tenant, before reading the id or the body", async () => {
    const w = await pathWorld();
    const path = await w.makePath({ title: "Same" });

    for (const [name, ctx] of w.outsiders) {
      expect(await errorCodeOf(() => updateLearningPath(ctx, path.id, { title: "X" })), name).toBe(
        "FORBIDDEN"
      );
      expect(await errorCodeOf(() => updateLearningPath(ctx, "!!", { bad: 1 })), name).toBe(
        "FORBIDDEN"
      );
    }
    expect((await row(path.id)).title).toBe("Same");
  });

  it("moves updatedAt", async () => {
    const w = await pathWorld();
    const path = await w.makePath();
    const before = (await row(path.id)).updatedAt;
    await new Promise((r) => setTimeout(r, 15));

    const updated = await updateLearningPath(w.admin.ctx, path.id, { title: "Later" });

    expect(updated.updatedAt.getTime()).toBeGreaterThan(before.getTime());
  });
});
