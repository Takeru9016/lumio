import { auth } from "@clerk/nextjs/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { ourFileRouter } from "@/app/api/uploadthing/core";
import { db } from "@/lib/db";
import { createCourse } from "@/lib/domain/capability/__test__/fixtures";
import { createSoloUser, createUserInTenant } from "@/lib/domain/course/__test__/fixtures";
import {
  authorizeLessonVideoUpload,
  ContentAuthorizationError,
  filterLessonIdsInCourse,
  instructorControlsCourse,
  resolveLessonChain,
} from "@/lib/domain/course/contentAuthorization";
import { createTenantUser } from "@/lib/domain/knowledge/__test__/fixtures";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));

afterEach(() => {
  vi.mocked(auth).mockReset();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("resolveLessonChain / filterLessonIdsInCourse", () => {
  it("resolves lesson -> section -> course from the database", async () => {
    const { tenant, user } = await createTenantUser("INSTRUCTOR");
    const { course, section, lesson } = await createCourse(tenant.id, user.id);

    const chain = await resolveLessonChain(lesson.id);

    expect(chain).toEqual({
      lessonId: lesson.id,
      sectionId: section.id,
      courseId: course.id,
      instructorId: user.id,
      tenantId: tenant.id,
    });
  });

  it("returns null for a nonexistent or malformed lesson id", async () => {
    expect(await resolveLessonChain("nope")).toBeNull();
    expect(await resolveLessonChain("")).toBeNull();
  });

  it("filterLessonIdsInCourse returns only lessons that belong to the course", async () => {
    const { tenant, user } = await createTenantUser("INSTRUCTOR");
    const a = await createCourse(tenant.id, user.id);
    const b = await createCourse(tenant.id, user.id);

    const owned = await filterLessonIdsInCourse(a.course.id, [a.lesson.id, b.lesson.id, "nope"]);

    expect([...owned]).toEqual([a.lesson.id]);
  });
});

describe("instructorControlsCourse", () => {
  it("requires ownership", () => {
    expect(
      instructorControlsCourse({ id: "u1", tenantId: "t1" }, { instructorId: "u2", tenantId: "t1" })
    ).toBe(false);
  });

  it("a tenant course requires the instructor to be in that tenant", () => {
    expect(
      instructorControlsCourse({ id: "u1", tenantId: "t2" }, { instructorId: "u1", tenantId: "t1" })
    ).toBe(false);
    expect(
      instructorControlsCourse({ id: "u1", tenantId: "t1" }, { instructorId: "u1", tenantId: "t1" })
    ).toBe(true);
  });

  it("a solo course (no tenant) is governed by ownership alone", () => {
    expect(
      instructorControlsCourse({ id: "u1", tenantId: null }, { instructorId: "u1", tenantId: null })
    ).toBe(true);
    expect(
      instructorControlsCourse({ id: "u1", tenantId: "t9" }, { instructorId: "u1", tenantId: null })
    ).toBe(true);
  });
});

describe("authorizeLessonVideoUpload", () => {
  it("allows the instructor who owns the lesson's course", async () => {
    const { tenant, user } = await createTenantUser("INSTRUCTOR");
    const { lesson } = await createCourse(tenant.id, user.id);

    const result = await authorizeLessonVideoUpload(user.clerkId, lesson.id);

    expect(result).toEqual({ userId: user.clerkId, lessonId: lesson.id });
  });

  it("denies an instructor from another tenant (404, indistinguishable from missing)", async () => {
    const { tenant, user } = await createTenantUser("INSTRUCTOR");
    const { user: outsider } = await createTenantUser("INSTRUCTOR");
    const { lesson } = await createCourse(tenant.id, user.id);

    await expect(authorizeLessonVideoUpload(outsider.clerkId, lesson.id)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("denies an instructor who owns a DIFFERENT course but targets a foreign lesson", async () => {
    const { tenant, user: owner } = await createTenantUser("INSTRUCTOR");
    const sameTenantInstructor = await createUserInTenant(tenant.id, "INSTRUCTOR");
    const foreign = await createCourse(tenant.id, owner.id);
    await createCourse(tenant.id, sameTenantInstructor.id);

    await expect(
      authorizeLessonVideoUpload(sameTenantInstructor.clerkId, foreign.lesson.id)
    ).rejects.toMatchObject({ status: 404 });
  });

  it("denies a malformed / nonexistent lesson id", async () => {
    const { user } = await createTenantUser("INSTRUCTOR");

    await expect(authorizeLessonVideoUpload(user.clerkId, "not-a-lesson")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("preserves the existing SUPER_ADMIN allowance for any existing lesson", async () => {
    const { tenant, user } = await createTenantUser("INSTRUCTOR");
    const { user: superAdmin } = await createTenantUser("SUPER_ADMIN");
    const { lesson } = await createCourse(tenant.id, user.id);

    const result = await authorizeLessonVideoUpload(superAdmin.clerkId, lesson.id);

    expect(result.lessonId).toBe(lesson.id);
  });

  it("denies STUDENT and ORG_ADMIN with 403", async () => {
    const { tenant, user } = await createTenantUser("INSTRUCTOR");
    const student = await createUserInTenant(tenant.id, "STUDENT");
    const orgAdmin = await createUserInTenant(tenant.id, "ORG_ADMIN");
    const { lesson } = await createCourse(tenant.id, user.id);

    await expect(authorizeLessonVideoUpload(student.clerkId, lesson.id)).rejects.toMatchObject({
      status: 403,
    });
    await expect(authorizeLessonVideoUpload(orgAdmin.clerkId, lesson.id)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("denies an unauthenticated caller with 401", async () => {
    await expect(authorizeLessonVideoUpload(null, "x")).rejects.toBeInstanceOf(
      ContentAuthorizationError
    );
    await expect(authorizeLessonVideoUpload(undefined, "x")).rejects.toMatchObject({ status: 401 });
  });

  it("a solo instructor (no tenant) can upload to their own solo course only", async () => {
    const solo = await createSoloUser("INSTRUCTOR");
    const otherSolo = await createSoloUser("INSTRUCTOR");
    const course = await db.course.create({
      data: { title: "solo", slug: `solo-${Date.now()}-${Math.random()}`, instructorId: solo.id },
    });
    const section = await db.section.create({
      data: { title: "s", order: 0, courseId: course.id },
    });
    const lesson = await db.lesson.create({
      data: {
        title: "l",
        slug: `l-${Date.now()}-${Math.random()}`,
        type: "VIDEO",
        order: 0,
        sectionId: section.id,
      },
    });

    await expect(authorizeLessonVideoUpload(solo.clerkId, lesson.id)).resolves.toMatchObject({
      lessonId: lesson.id,
    });
    await expect(authorizeLessonVideoUpload(otherSolo.clerkId, lesson.id)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("videoUploader middleware is wired to authorizeLessonVideoUpload", () => {
  const run = (lessonId: string) =>
    (
      ourFileRouter.videoUploader as unknown as {
        middleware: (opts: { input: { lessonId: string } }) => Promise<unknown>;
      }
    ).middleware({ input: { lessonId } });

  it("returns the server-verified lessonId for the owner", async () => {
    const { tenant, user } = await createTenantUser("INSTRUCTOR");
    const { lesson } = await createCourse(tenant.id, user.id);
    vi.mocked(auth).mockResolvedValue({ userId: user.clerkId } as never);

    await expect(run(lesson.id)).resolves.toEqual({ userId: user.clerkId, lessonId: lesson.id });
  });

  it("rejects a foreign instructor's lesson before any upload is accepted", async () => {
    const { tenant, user } = await createTenantUser("INSTRUCTOR");
    const { user: outsider } = await createTenantUser("INSTRUCTOR");
    const { lesson } = await createCourse(tenant.id, user.id);
    vi.mocked(auth).mockResolvedValue({ userId: outsider.clerkId } as never);

    await expect(run(lesson.id)).rejects.toMatchObject({ status: 404 });
  });

  it("rejects an unauthenticated request", async () => {
    vi.mocked(auth).mockResolvedValue({ userId: null } as never);

    await expect(run("anything")).rejects.toMatchObject({ status: 401 });
  });
});
