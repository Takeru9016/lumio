import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createTenantUser } from "@/lib/domain/knowledge/__test__/fixtures";
import { createNotification } from "@/lib/notifications";

afterAll(async () => {
  await db.$disconnect();
});

function params(userId: string, tenantId: string, extra: { dedupeKey?: string } = {}) {
  return {
    userId,
    tenantId,
    type: "LEARNING_ASSIGNED" as const,
    title: "New learning assigned",
    body: "You have been assigned a course.",
    link: "/courses/example",
    ...extra,
  };
}

describe("createNotification — without a dedupe key", () => {
  it("creates a row each time and reports created", async () => {
    const { tenant, user } = await createTenantUser("STUDENT");

    const first = await createNotification(params(user.id, tenant.id));
    const second = await createNotification(params(user.id, tenant.id));

    expect(first).toEqual({ created: true });
    expect(second).toEqual({ created: true });
    expect(await db.notification.count({ where: { userId: user.id } })).toBe(2);
  });

  it("stores a null dedupeKey", async () => {
    const { tenant, user } = await createTenantUser("STUDENT");
    await createNotification(params(user.id, tenant.id));

    const row = await db.notification.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.dedupeKey).toBeNull();
  });
});

describe("createNotification — with a dedupe key", () => {
  it("creates the notification the first time and reports created", async () => {
    const { tenant, user } = await createTenantUser("STUDENT");

    const result = await createNotification(
      params(user.id, tenant.id, { dedupeKey: "assignment:a1:assigned" })
    );

    expect(result).toEqual({ created: true });
    const rows = await db.notification.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupeKey).toBe("assignment:a1:assigned");
    expect(rows[0].type).toBe("LEARNING_ASSIGNED");
  });

  it("is a no-op for a repeated key and reports not created", async () => {
    const { tenant, user } = await newStudent();
    const dedupeKey = "assignment:a2:assigned";

    await createNotification({ ...params(user.id, tenant.id, { dedupeKey }), title: "Original" });
    const repeat = await createNotification({
      ...params(user.id, tenant.id, { dedupeKey }),
      title: "Changed",
    });

    expect(repeat).toEqual({ created: false });
    const rows = await db.notification.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Original");
  });

  it("does not resurrect a notification the user already marked read", async () => {
    const { tenant, user } = await newStudent();
    const dedupeKey = "assignment:a3:assigned";
    await createNotification(params(user.id, tenant.id, { dedupeKey }));
    await db.notification.updateMany({ where: { userId: user.id }, data: { isRead: true } });

    const repeat = await createNotification(params(user.id, tenant.id, { dedupeKey }));

    expect(repeat).toEqual({ created: false });
    const row = await db.notification.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.isRead).toBe(true);
  });

  it("treats the same key for different users as independent", async () => {
    const { tenant, user: userA } = await newStudent();
    const userB = await db.user.create({
      data: {
        clerkId: `clerk-b-${Date.now()}`,
        email: `b-${Date.now()}@example.test`,
        tenantId: tenant.id,
      },
    });
    const dedupeKey = "assignment:shared:assigned";

    const a = await createNotification(params(userA.id, tenant.id, { dedupeKey }));
    const b = await createNotification(params(userB.id, tenant.id, { dedupeKey }));

    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
  });

  it("treats different keys for the same user as independent", async () => {
    const { tenant, user } = await newStudent();

    const a = await createNotification(
      params(user.id, tenant.id, { dedupeKey: "assignment:a4:assigned" })
    );
    const b = await createNotification(
      params(user.id, tenant.id, { dedupeKey: "assignment:a4:due_soon:2026-10-01" })
    );

    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(await db.notification.count({ where: { userId: user.id } })).toBe(2);
  });

  it("produces exactly one row and one created=true under concurrent creation", async () => {
    const { tenant, user } = await newStudent();
    const dedupeKey = "assignment:race:assigned";

    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        createNotification(params(user.id, tenant.id, { dedupeKey }))
      )
    );

    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results.filter((r) => !r.created)).toHaveLength(11);
    expect(await db.notification.count({ where: { userId: user.id, dedupeKey } })).toBe(1);
  });
});

async function newStudent() {
  return createTenantUser("STUDENT");
}
