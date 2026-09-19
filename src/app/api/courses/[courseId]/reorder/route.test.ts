import { auth } from "@clerk/nextjs/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { createCourse } from "@/lib/domain/capability/__test__/fixtures";
import { addLesson, addSection, createUserInTenant } from "@/lib/domain/course/__test__/fixtures";
import { createTenantUser } from "@/lib/domain/knowledge/__test__/fixtures";
import { POST } from "./route";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));

const call = (courseSlug: string, body: unknown) =>
  POST(new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) }) as never, {
    params: Promise.resolve({ courseId: courseSlug }),
  });

const signInAs = (clerkId: string | null) =>
  vi.mocked(auth).mockResolvedValue({ userId: clerkId } as never);

afterEach(() => {
  vi.mocked(auth).mockReset();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("POST /api/courses/[courseId]/reorder — lesson branch", () => {
  it("the course owner can reorder their own lessons, and only `order` changes", async () => {
    const { tenant, user } = await createTenantUser("INSTRUCTOR");
    const { course, section, lesson } = await createCourse(tenant.id, user.id);
    const second = await addLesson(section.id, 2);
    const before = await db.lesson.findUnique({ where: { id: lesson.id } });
    signInAs(user.clerkId);

    const res = await call(course.slug, {
      type: "lesson",
      items: [
        { id: lesson.id, order: 7 },
        { id: second.id, order: 3 },
      ],
    });

    expect(res.status).toBe(200);
    const after = await db.lesson.findUnique({ where: { id: lesson.id } });
    expect(after?.order).toBe(7);
    expect((await db.lesson.findUnique({ where: { id: second.id } }))?.order).toBe(3);
    expect({ ...after, order: 0, updatedAt: null }).toEqual({
      ...before,
      order: 0,
      updatedAt: null,
    });
  });

  it("an instructor cannot reorder another course's lesson (404) and nothing changes", async () => {
    const { tenant, user } = await createTenantUser("INSTRUCTOR");
    const mine = await createCourse(tenant.id, user.id);
    const theirs = await createCourse(
      tenant.id,
      (await createUserInTenant(tenant.id, "INSTRUCTOR")).id
    );
    signInAs(user.clerkId);

    const res = await call(mine.course.slug, {
      type: "lesson",
      items: [{ id: theirs.lesson.id, order: 9 }],
    });

    expect(res.status).toBe(404);
    expect((await db.lesson.findUnique({ where: { id: theirs.lesson.id } }))?.order).toBe(0);
  });

  it("a cross-tenant lesson id is denied (404) and unchanged", async () => {
    const { tenant, user } = await createTenantUser("INSTRUCTOR");
    const mine = await createCourse(tenant.id, user.id);
    const { tenant: otherTenant, user: otherInstructor } = await createTenantUser("INSTRUCTOR");
    const foreign = await createCourse(otherTenant.id, otherInstructor.id);
    signInAs(user.clerkId);

    const res = await call(mine.course.slug, {
      type: "lesson",
      items: [{ id: foreign.lesson.id, order: 9 }],
    });

    expect(res.status).toBe(404);
    expect((await db.lesson.findUnique({ where: { id: foreign.lesson.id } }))?.order).toBe(0);
  });

  it("a mixed batch (one own lesson + one foreign) is rejected whole — nothing is partially reordered", async () => {
    const { tenant, user } = await createTenantUser("INSTRUCTOR");
    const mine = await createCourse(tenant.id, user.id);
    const { tenant: otherTenant, user: otherInstructor } = await createTenantUser("INSTRUCTOR");
    const foreign = await createCourse(otherTenant.id, otherInstructor.id);
    signInAs(user.clerkId);

    const res = await call(mine.course.slug, {
      type: "lesson",
      items: [
        { id: mine.lesson.id, order: 4 },
        { id: foreign.lesson.id, order: 9 },
      ],
    });

    expect(res.status).toBe(404);
    expect((await db.lesson.findUnique({ where: { id: mine.lesson.id } }))?.order).toBe(0);
  });

  it("a lesson in another section of the SAME course is allowed (it is the same course)", async () => {
    const { tenant, user } = await createTenantUser("INSTRUCTOR");
    const { course } = await createCourse(tenant.id, user.id);
    const otherSection = await addSection(course.id);
    const inOtherSection = await addLesson(otherSection.id, 1);
    signInAs(user.clerkId);

    const res = await call(course.slug, {
      type: "lesson",
      items: [{ id: inOtherSection.id, order: 6 }],
    });

    expect(res.status).toBe(200);
  });

  it("a nonexistent lesson id -> 404", async () => {
    const { tenant, user } = await createTenantUser("INSTRUCTOR");
    const { course } = await createCourse(tenant.id, user.id);
    signInAs(user.clerkId);

    const res = await call(course.slug, { type: "lesson", items: [{ id: "nope", order: 1 }] });

    expect(res.status).toBe(404);
  });

  it("unauthenticated -> 401; another instructor's course slug -> 403 (unchanged behavior)", async () => {
    const { tenant, user } = await createTenantUser("INSTRUCTOR");
    const other = await createUserInTenant(tenant.id, "INSTRUCTOR");
    const { course, lesson } = await createCourse(tenant.id, user.id);
    const body = { type: "lesson", items: [{ id: lesson.id, order: 2 }] };

    signInAs(null);
    expect((await call(course.slug, body)).status).toBe(401);
    signInAs(other.clerkId);
    expect((await call(course.slug, body)).status).toBe(403);
  });
});

describe("POST /api/courses/[courseId]/reorder — section branch (existing behavior preserved)", () => {
  it("owner can reorder their own sections", async () => {
    const { tenant, user } = await createTenantUser("INSTRUCTOR");
    const { course, section } = await createCourse(tenant.id, user.id);
    signInAs(user.clerkId);

    const res = await call(course.slug, { type: "section", items: [{ id: section.id, order: 4 }] });

    expect(res.status).toBe(200);
    expect((await db.section.findUnique({ where: { id: section.id } }))?.order).toBe(4);
  });
});
