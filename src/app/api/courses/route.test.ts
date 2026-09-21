import { auth } from "@clerk/nextjs/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { createCourse } from "@/lib/domain/capability/__test__/fixtures";
import { createSoloUser } from "@/lib/domain/course/__test__/fixtures";
import { createTenantUser } from "@/lib/domain/knowledge/__test__/fixtures";
import * as route from "./route";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));

function post(body: unknown) {
  return new Request("http://localhost/api/courses", {
    method: "POST",
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof route.POST>[0];
}

afterEach(() => {
  vi.mocked(auth).mockReset();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("/api/courses — exported handlers", () => {
  it("no longer exports GET, so the unscoped course listing answers 405", () => {
    expect((route as Record<string, unknown>).GET).toBeUndefined();
    expect(Object.keys(route).sort()).toEqual(["POST"]);
  });
});

describe("POST /api/courses — authorization (unchanged)", () => {
  it("401s when unauthenticated", async () => {
    vi.mocked(auth).mockResolvedValue({ userId: null } as never);

    const res = await route.POST(post({ title: "Nope" }));

    expect(res.status).toBe(401);
  });

  it("403s when the Clerk user has no database row", async () => {
    vi.mocked(auth).mockResolvedValue({ userId: "clerk-not-in-db" } as never);

    const res = await route.POST(post({ title: "Nope" }));

    expect(res.status).toBe(403);
  });

  it.each(["STUDENT", "ORG_ADMIN", "SUPER_ADMIN"] as const)(
    "403s a %s and creates no course",
    async (role) => {
      const { user } = await createTenantUser(role);
      vi.mocked(auth).mockResolvedValue({ userId: user.clerkId } as never);

      const res = await route.POST(post({ title: `Denied ${role}` }));

      expect(res.status).toBe(403);
      expect(await db.course.count({ where: { title: `Denied ${role}` } })).toBe(0);
    }
  );

  it("403s with upgradeRequired once the plan's course limit is reached", async () => {
    const { tenant, user } = await createTenantUser("INSTRUCTOR");
    await createCourse(tenant.id, user.id);
    vi.mocked(auth).mockResolvedValue({ userId: user.clerkId } as never);

    const res = await route.POST(post({ title: "One too many" }));

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ upgradeRequired: true });
  });
});

describe("POST /api/courses — creation (regression)", () => {
  it("creates a DRAFT course owned by the authenticated instructor", async () => {
    const { user } = await createTenantUser("INSTRUCTOR");
    vi.mocked(auth).mockResolvedValue({ userId: user.clerkId } as never);

    const res = await route.POST(
      post({ title: "Regression Course", description: "d", level: "BEGINNER", price: 10 })
    );

    expect(res.status).toBe(201);
    const created = await res.json();
    const stored = await db.course.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored.instructorId).toBe(user.id);
    expect(stored.title).toBe("Regression Course");
    expect(stored.status).toBe("DRAFT");
    expect(stored.price).toBe(10);
  });

  it("400s on an invalid body without creating anything", async () => {
    const { user } = await createTenantUser("INSTRUCTOR");
    vi.mocked(auth).mockResolvedValue({ userId: user.clerkId } as never);

    const res = await route.POST(post({ title: "" }));

    expect(res.status).toBe(400);
    expect(await db.course.count({ where: { instructorId: user.id } })).toBe(0);
  });

  it("ignores client-supplied instructorId, tenantId, status, slug and publishedAt", async () => {
    const { tenant, user } = await createTenantUser("INSTRUCTOR");
    const { tenant: otherTenant, user: otherInstructor } = await createTenantUser("INSTRUCTOR");
    vi.mocked(auth).mockResolvedValue({ userId: user.clerkId } as never);

    const res = await route.POST(
      post({
        title: "Substitution Attempt",
        instructorId: otherInstructor.id,
        tenantId: otherTenant.id,
        status: "PUBLISHED",
        slug: "attacker-chosen-slug",
        publishedAt: new Date().toISOString(),
      })
    );

    expect(res.status).toBe(201);
    const created = await res.json();
    const stored = await db.course.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored.instructorId).toBe(user.id);
    expect(stored.tenantId).toBe(tenant.id);
    expect(stored.tenantId).not.toBe(otherTenant.id);
    expect(stored.status).toBe("DRAFT");
    expect(stored.publishedAt).toBeNull();
    expect(stored.slug).not.toBe("attacker-chosen-slug");
    expect(await db.course.count({ where: { instructorId: otherInstructor.id } })).toBe(0);
  });
});

describe("POST /api/courses — tenant ownership (Phase 29.0)", () => {
  it("a course created by a tenant instructor belongs to that instructor's tenant", async () => {
    const { tenant, user } = await createTenantUser("INSTRUCTOR");
    vi.mocked(auth).mockResolvedValue({ userId: user.clerkId } as never);

    const res = await route.POST(post({ title: "Tenant-owned course" }));

    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.tenantId).toBe(tenant.id);
    const stored = await db.course.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored.tenantId).toBe(tenant.id);
  });

  it("a forged tenantId never assigns ownership to another tenant", async () => {
    const { tenant, user } = await createTenantUser("INSTRUCTOR");
    const { tenant: victim } = await createTenantUser("INSTRUCTOR");
    vi.mocked(auth).mockResolvedValue({ userId: user.clerkId } as never);

    const res = await route.POST(post({ title: "Forged tenant", tenantId: victim.id }));

    expect(res.status).toBe(201);
    const stored = await db.course.findUniqueOrThrow({ where: { id: (await res.json()).id } });
    expect(stored.tenantId).toBe(tenant.id);
    expect(await db.course.count({ where: { tenantId: victim.id } })).toBe(0);
  });

  it("a solo instructor with no tenant still creates a tenantless course, and a forged tenantId does not change that", async () => {
    const solo = await createSoloUser("INSTRUCTOR");
    const { tenant: victim } = await createTenantUser("INSTRUCTOR");
    vi.mocked(auth).mockResolvedValue({ userId: solo.clerkId } as never);

    const res = await route.POST(post({ title: "Solo course", tenantId: victim.id }));

    expect(res.status).toBe(201);
    const stored = await db.course.findUniqueOrThrow({ where: { id: (await res.json()).id } });
    expect(stored.instructorId).toBe(solo.id);
    expect(stored.tenantId).toBeNull();
    expect(await db.course.count({ where: { tenantId: victim.id } })).toBe(0);
  });

  it("does not touch a course that already exists: earlier tenantless courses stay as they are", async () => {
    const { tenant, user } = await createTenantUser("INSTRUCTOR");
    const existing = await db.course.create({
      data: {
        title: "Legacy",
        slug: `legacy-${Date.now()}`,
        instructorId: user.id,
        tenantId: null,
      },
    });
    await db.user.update({ where: { id: user.id }, data: { plan: "PRO" } });
    vi.mocked(auth).mockResolvedValue({ userId: user.clerkId } as never);

    const res = await route.POST(post({ title: "Newer course" }));

    expect(res.status).toBe(201);
    expect((await res.json()).tenantId).toBe(tenant.id);
    const reloaded = await db.course.findUniqueOrThrow({ where: { id: existing.id } });
    expect(reloaded.tenantId).toBeNull();
    expect(reloaded.updatedAt.getTime()).toBe(existing.updatedAt.getTime());
  });
});
