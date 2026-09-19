import { auth } from "@clerk/nextjs/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { createCourse } from "@/lib/domain/capability/__test__/fixtures";
import { createUserInTenant } from "@/lib/domain/course/__test__/fixtures";
import { createTenantUser } from "@/lib/domain/knowledge/__test__/fixtures";
import { GET } from "./route";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));

const call = (courseSlug: string, sectionId: string) =>
  GET(new Request("http://localhost/x") as never, {
    params: Promise.resolve({ courseId: courseSlug, sectionId }),
  });

const signInAs = (clerkId: string | null) =>
  vi.mocked(auth).mockResolvedValue({ userId: clerkId } as never);

afterEach(() => {
  vi.mocked(auth).mockReset();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("GET /api/courses/[courseId]/sections/[sectionId]/lessons — authorization", () => {
  it("course owner reads own section lessons, with editor fields only", async () => {
    const { tenant, user } = await createTenantUser("INSTRUCTOR");
    const { course, section, lesson } = await createCourse(tenant.id, user.id);
    await db.lesson.update({ where: { id: lesson.id }, data: { textContent: "private body" } });
    signInAs(user.clerkId);

    const res = await call(course.slug, section.id);
    const body = (await res.json()) as Array<Record<string, unknown>>;

    expect(res.status).toBe(200);
    expect(body.map((l) => l.id)).toEqual([lesson.id]);
    expect(Object.keys(body[0]).sort()).toEqual(
      [
        "id",
        "isArchived",
        "isPublished",
        "muxPlaybackId",
        "order",
        "title",
        "type",
        "videoDuration",
        "videoStatus",
      ].sort()
    );
    expect(JSON.stringify(body)).not.toContain("private body");
  });

  it("unauthenticated -> 401", async () => {
    signInAs(null);
    const res = await call("any", "any");
    expect(res.status).toBe(401);
  });

  it("another instructor in the SAME tenant -> 403", async () => {
    const { tenant, user } = await createTenantUser("INSTRUCTOR");
    const other = await createUserInTenant(tenant.id, "INSTRUCTOR");
    const { course, section } = await createCourse(tenant.id, user.id);
    signInAs(other.clerkId);

    const res = await call(course.slug, section.id);

    expect(res.status).toBe(403);
  });

  it("an instructor from ANOTHER tenant -> 404 (never confirms the course exists)", async () => {
    const { tenant, user } = await createTenantUser("INSTRUCTOR");
    const { user: outsider } = await createTenantUser("INSTRUCTOR");
    const { course, section } = await createCourse(tenant.id, user.id);
    signInAs(outsider.clerkId);

    const res = await call(course.slug, section.id);

    expect(res.status).toBe(404);
  });

  it("a section that belongs to a DIFFERENT course (own slug + foreign section id) -> 404", async () => {
    const { tenant, user } = await createTenantUser("INSTRUCTOR");
    const mine = await createCourse(tenant.id, user.id);
    const { tenant: otherTenant, user: otherInstructor } = await createTenantUser("INSTRUCTOR");
    const foreign = await createCourse(otherTenant.id, otherInstructor.id);
    signInAs(user.clerkId);

    const res = await call(mine.course.slug, foreign.section.id);
    const body = await res.text();

    expect(res.status).toBe(404);
    expect(body).not.toContain(foreign.lesson.id);
  });

  it("a nonexistent course slug -> 404", async () => {
    const { user } = await createTenantUser("INSTRUCTOR");
    signInAs(user.clerkId);
    const res = await call("nope", "nope");
    expect(res.status).toBe(404);
  });
});

describe("GET section lessons — paywall / unpublished content", () => {
  it("a student who has NOT enrolled cannot read a paid course's lessons (403)", async () => {
    const { tenant, user } = await createTenantUser("INSTRUCTOR");
    const student = await createUserInTenant(tenant.id, "STUDENT");
    const { course, section, lesson } = await createCourse(tenant.id, user.id);
    await db.course.update({ where: { id: course.id }, data: { price: 999, status: "PUBLISHED" } });
    signInAs(student.clerkId);

    const res = await call(course.slug, section.id);

    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(lesson.id);
  });

  it("an unauthorized user cannot read an UNPUBLISHED (draft) course's lessons", async () => {
    const { tenant, user } = await createTenantUser("INSTRUCTOR");
    const student = await createUserInTenant(tenant.id, "STUDENT");
    const { course, section, lesson } = await createCourse(tenant.id, user.id);
    await db.lesson.update({ where: { id: lesson.id }, data: { isPublished: false } });
    signInAs(student.clerkId);

    const res = await call(course.slug, section.id);

    expect(res.status).toBe(403);
    expect(course.status).toBe("DRAFT");
  });

  it("ORG_ADMIN and SUPER_ADMIN lose the pre-Phase-23 blanket read (403) — instructor-owner only", async () => {
    const { tenant, user } = await createTenantUser("INSTRUCTOR");
    const orgAdmin = await createUserInTenant(tenant.id, "ORG_ADMIN");
    const superAdmin = await createUserInTenant(tenant.id, "SUPER_ADMIN");
    const { course, section } = await createCourse(tenant.id, user.id);

    signInAs(orgAdmin.clerkId);
    expect((await call(course.slug, section.id)).status).toBe(403);
    signInAs(superAdmin.clerkId);
    expect((await call(course.slug, section.id)).status).toBe(403);
  });
});
