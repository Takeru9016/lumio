import { afterAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { createCourse } from "@/lib/domain/capability/__test__/fixtures";
import { addLesson, addSection } from "@/lib/domain/course/__test__/fixtures";
import { createTenantUser } from "@/lib/domain/knowledge/__test__/fixtures";

// Every lesson and the query share one vector, so ranking never hides a
// scoping bug: whatever the SQL is allowed to see, it will return.
const VECTOR = `[${Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]`;

vi.mock("@/lib/ai/embeddings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/embeddings")>();
  return {
    ...actual,
    generateEmbedding: vi.fn(async () => Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0))),
  };
});

const { searchSimilarLessons } = await import("@/lib/ai/search");

afterAll(async () => {
  await db.$disconnect();
});

async function embeddedCourse(tenantId: string, instructorId: string) {
  const { course, section, lesson } = await createCourse(tenantId, instructorId);
  const second = await addLesson(section.id, 3);
  const otherSection = await addSection(course.id);
  const third = await addLesson(otherSection.id, 1);
  const ids = [lesson.id, second.id, third.id];
  await db.lesson.update({ where: { id: lesson.id }, data: { textContent: "body" } });
  for (const id of ids) {
    await db.$executeRaw`UPDATE "Lesson" SET embedding = ${VECTOR}::vector WHERE id = ${id}`;
  }
  return { course, ids };
}

describe("searchSimilarLessons — course scope is mandatory and enforced", () => {
  it("returns only lessons of the given course, never another course or another tenant's", async () => {
    const { tenant, user } = await createTenantUser("INSTRUCTOR");
    const { tenant: otherTenant, user: otherInstructor } = await createTenantUser("INSTRUCTOR");
    const mine = await embeddedCourse(tenant.id, user.id);
    const sameTenantOther = await embeddedCourse(tenant.id, user.id);
    const foreign = await embeddedCourse(otherTenant.id, otherInstructor.id);

    const results = await searchSimilarLessons("anything", mine.course.id, 50);
    const found = results.map((r) => r.id);

    expect(found.sort()).toEqual([...mine.ids].sort());
    for (const id of [...sameTenantOther.ids, ...foreign.ids]) {
      expect(found).not.toContain(id);
    }
  });

  it("scoping to a foreign course returns only that course (proves the scope is the caller's argument, not global)", async () => {
    const { tenant, user } = await createTenantUser("INSTRUCTOR");
    const a = await embeddedCourse(tenant.id, user.id);
    const b = await embeddedCourse(tenant.id, user.id);

    const results = await searchSimilarLessons("q", b.course.id, 50);

    expect(results.map((r) => r.id).sort()).toEqual([...b.ids].sort());
    expect(results.map((r) => r.id)).not.toContain(a.ids[0]);
  });

  it("refuses an omitted or empty course scope instead of searching globally", async () => {
    await expect(
      (searchSimilarLessons as unknown as (q: string) => Promise<unknown>)("q")
    ).rejects.toThrow("requires a course scope");
    await expect(searchSimilarLessons("q", "")).rejects.toThrow("requires a course scope");
  });

  it("still excludes unpublished and archived lessons within the scoped course", async () => {
    const { tenant, user } = await createTenantUser("INSTRUCTOR");
    const { course, ids } = await embeddedCourse(tenant.id, user.id);
    await db.lesson.update({ where: { id: ids[1] }, data: { isPublished: false } });
    await db.lesson.update({ where: { id: ids[2] }, data: { isArchived: true } });

    const results = await searchSimilarLessons("q", course.id, 50);

    expect(results.map((r) => r.id)).toEqual([ids[0]]);
  });
});
