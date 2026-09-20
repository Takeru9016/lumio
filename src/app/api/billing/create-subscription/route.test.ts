import crypto from "node:crypto";
import { auth } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Role, SubscriptionStatus } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { createSoloUser, createUserInTenant } from "@/lib/domain/course/__test__/fixtures";
import { createTenantUser } from "@/lib/domain/knowledge/__test__/fixtures";

/**
 * POST /api/billing/create-subscription against the REAL database. Only Clerk
 * and Razorpay are mocked. Every denied request asserts the two guarantees
 * that matter: Razorpay was never called, and no row changed.
 */
vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));
vi.mock("@/lib/razorpay", () => ({
  razorpay: { subscriptions: { create: vi.fn(), cancel: vi.fn() } },
}));

vi.mock("@/lib/resend", () => ({ resend: { emails: { send: vi.fn().mockResolvedValue({}) } } }));

const { razorpay } = await import("@/lib/razorpay");
const { POST } = await import("./route");
const { GET: runDowngradeCron } = await import("@/app/api/cron/downgrade-subscriptions/route");
const { POST: razorpayWebhook } = await import("@/app/api/webhooks/razorpay/route");

const createMock = vi.mocked(razorpay.subscriptions.create);
const cancelMock = vi.mocked(razorpay.subscriptions.cancel);

const ENV_KEYS = [
  "RAZORPAY_PLAN_STARTER",
  "RAZORPAY_PLAN_PRO",
  "RAZORPAY_PLAN_ENTERPRISE",
  "NEXT_PUBLIC_RAZORPAY_KEY_ID",
  "CRON_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
] as const;
const savedEnv: Record<string, string | undefined> = {};

let subCounter = 0;

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.RAZORPAY_PLAN_STARTER = "plan_starter_test";
  process.env.RAZORPAY_PLAN_PRO = "plan_pro_test";
  process.env.RAZORPAY_PLAN_ENTERPRISE = "plan_enterprise_test";
  process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = "rzp_test_key";
  process.env.CRON_SECRET = "cron-secret-test";
  process.env.RAZORPAY_WEBHOOK_SECRET = "webhook-secret-test";

  createMock.mockReset();
  cancelMock.mockReset();
  createMock.mockImplementation((async () => {
    subCounter += 1;
    return { id: `sub_new_${Date.now()}_${subCounter}` };
  }) as never);
  cancelMock.mockResolvedValue({} as never);
});

afterEach(() => {
  vi.mocked(auth).mockReset();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

afterAll(async () => {
  await db.$disconnect();
});

function call(clerkId: string | null, body: unknown) {
  vi.mocked(auth).mockResolvedValue({ userId: clerkId } as never);
  return POST(
    new Request("http://localhost/api/billing/create-subscription", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  );
}

async function seedOrg(role: Role = "ORG_ADMIN") {
  const { tenant, user } = await createTenantUser(role);
  return { tenant, user };
}

async function seedExistingSubscription(
  tenantId: string,
  ownerUserId: string,
  status: SubscriptionStatus | null
) {
  const subId = `sub_existing_${Date.now()}_${++subCounter}`;
  await db.tenant.update({ where: { id: tenantId }, data: { razorpaySubId: subId } });
  await db.user.update({
    where: { id: ownerUserId },
    data: { razorpaySubId: subId, subscriptionStatus: status },
  });
  return subId;
}

async function snapshot(tenantId: string, userIds: string[]) {
  const tenant = await db.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const users = await db.user.findMany({ where: { id: { in: userIds } }, orderBy: { id: "asc" } });
  return { tenant, users };
}

async function expectUntouched(
  before: Awaited<ReturnType<typeof snapshot>>,
  tenantId: string,
  userIds: string[]
) {
  expect(createMock).not.toHaveBeenCalled();
  expect(await snapshot(tenantId, userIds)).toEqual(before);
}

describe("POST /api/billing/create-subscription — authorization", () => {
  it("401s with no session and never reaches Razorpay", async () => {
    const res = await call(null, { plan: "STARTER" });

    expect(res.status).toBe(401);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("401s when the Clerk user has no database row", async () => {
    const res = await call("clerk-not-in-db", { plan: "STARTER" });

    expect(res.status).toBe(401);
    expect(createMock).not.toHaveBeenCalled();
  });

  it.each(["STUDENT", "INSTRUCTOR", "SUPER_ADMIN"] as const)(
    "403s a %s in the organisation: no Razorpay call and no row changes",
    async (role) => {
      const { tenant, user: admin } = await seedOrg("ORG_ADMIN");
      const actor = await createUserInTenant(tenant.id, role);
      const before = await snapshot(tenant.id, [admin.id, actor.id]);

      const res = await call(actor.clerkId, { plan: "STARTER" });

      expect(res.status).toBe(403);
      await expectUntouched(before, tenant.id, [admin.id, actor.id]);
    }
  );

  it("cannot let a student overwrite an organisation's existing subscription id", async () => {
    const { tenant, user: admin } = await seedOrg("ORG_ADMIN");
    const subId = await seedExistingSubscription(tenant.id, admin.id, "ACTIVE");
    const student = await createUserInTenant(tenant.id, "STUDENT");
    const before = await snapshot(tenant.id, [admin.id, student.id]);

    const res = await call(student.clerkId, { plan: "STARTER", seats: 1 });

    expect(res.status).toBe(403);
    await expectUntouched(before, tenant.id, [admin.id, student.id]);
    expect((await db.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).razorpaySubId).toBe(
      subId
    );
  });

  it("400s an ORG_ADMIN without a tenant: no Razorpay call, no row change", async () => {
    const admin = await db.user.create({
      data: {
        clerkId: `clerk-notenant-${Date.now()}-${++subCounter}`,
        email: `notenant-${Date.now()}-${subCounter}@example.test`,
        role: "ORG_ADMIN",
      },
    });
    const before = await db.user.findUniqueOrThrow({ where: { id: admin.id } });

    const res = await call(admin.clerkId, { plan: "STARTER" });

    expect(res.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
    expect(await db.user.findUniqueOrThrow({ where: { id: admin.id } })).toEqual(before);
  });

  it("denies a tenantless STUDENT before validating anything", async () => {
    const solo = await createSoloUser("STUDENT");

    const res = await call(solo.clerkId, { plan: "STARTER" });

    expect(res.status).toBe(403);
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/billing/create-subscription — creation", () => {
  it("creates a subscription for an ORG_ADMIN with the server-side plan id, quantity and notes", async () => {
    const { tenant, user: admin } = await seedOrg("ORG_ADMIN");

    const res = await call(admin.clerkId, { plan: "PRO", seats: 25 });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.razorpayKeyId).toBe("rzp_test_key");
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0][0]).toEqual({
      plan_id: "plan_pro_test",
      customer_notify: 1,
      quantity: 25,
      total_count: 120,
      notes: { userId: admin.clerkId, plan: "PRO", tenantId: tenant.id },
    });
    expect((await db.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).razorpaySubId).toBe(
      body.subscriptionId
    );
    expect((await db.user.findUniqueOrThrow({ where: { id: admin.id } })).razorpaySubId).toBe(
      body.subscriptionId
    );
  });

  it("defaults the quantity to 1 when seats is omitted", async () => {
    const { user: admin } = await seedOrg("ORG_ADMIN");

    const res = await call(admin.clerkId, { plan: "STARTER" });

    expect(res.status).toBe(200);
    expect(createMock.mock.calls[0][0]).toMatchObject({
      quantity: 1,
      plan_id: "plan_starter_test",
    });
  });

  it("changes only razorpaySubId: tenant plan, seat limit and subscription status stay as they were", async () => {
    const { tenant, user: admin } = await seedOrg("ORG_ADMIN");
    const beforeTenant = await db.tenant.findUniqueOrThrow({ where: { id: tenant.id } });
    const beforeUser = await db.user.findUniqueOrThrow({ where: { id: admin.id } });

    const res = await call(admin.clerkId, { plan: "ENTERPRISE" });
    expect(res.status).toBe(200);
    const { subscriptionId } = await res.json();

    const afterTenant = await db.tenant.findUniqueOrThrow({ where: { id: tenant.id } });
    const afterUser = await db.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(afterTenant).toEqual({
      ...beforeTenant,
      razorpaySubId: subscriptionId,
      updatedAt: afterTenant.updatedAt,
    });
    expect(afterUser).toEqual({
      ...beforeUser,
      razorpaySubId: subscriptionId,
      updatedAt: afterUser.updatedAt,
    });
    expect(afterTenant.plan).toBe(beforeTenant.plan);
    expect(afterTenant.seatLimit).toBe(beforeTenant.seatLimit);
    expect(afterUser.subscriptionStatus).toBe(beforeUser.subscriptionStatus);
  });

  it("ignores a client-supplied tenantId, userId, subscription id and role", async () => {
    const { tenant, user: admin } = await seedOrg("ORG_ADMIN");
    const { tenant: otherTenant, user: otherAdmin } = await seedOrg("ORG_ADMIN");
    const otherBefore = await snapshot(otherTenant.id, [otherAdmin.id]);

    const res = await call(admin.clerkId, {
      plan: "STARTER",
      tenantId: otherTenant.id,
      userId: otherAdmin.id,
      clerkId: otherAdmin.clerkId,
      razorpaySubId: "sub_attacker",
      subscriptionId: "sub_attacker",
      role: "SUPER_ADMIN",
    });

    expect(res.status).toBe(200);
    expect(createMock.mock.calls[0][0]).toMatchObject({
      notes: { userId: admin.clerkId, plan: "STARTER", tenantId: tenant.id },
    });
    const { subscriptionId } = await res.json();
    expect((await db.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).razorpaySubId).toBe(
      subscriptionId
    );
    expect(await snapshot(otherTenant.id, [otherAdmin.id])).toEqual(otherBefore);
  });

  it("only ever affects the authenticated admin's own tenant (cross-tenant isolation)", async () => {
    const { tenant: tenantA, user: adminA } = await seedOrg("ORG_ADMIN");
    const { tenant: tenantB, user: adminB } = await seedOrg("ORG_ADMIN");
    const subB = await seedExistingSubscription(tenantB.id, adminB.id, "ACTIVE");
    const bBefore = await snapshot(tenantB.id, [adminB.id]);

    const res = await call(adminA.clerkId, { plan: "STARTER", tenantId: tenantB.id });

    expect(res.status).toBe(200);
    expect(await snapshot(tenantB.id, [adminB.id])).toEqual(bBefore);
    expect((await db.tenant.findUniqueOrThrow({ where: { id: tenantB.id } })).razorpaySubId).toBe(
      subB
    );
    expect(
      (await db.tenant.findUniqueOrThrow({ where: { id: tenantA.id } })).razorpaySubId
    ).not.toBeNull();
  });

  it("500s without touching Razorpay or the database when the plan id is not configured", async () => {
    delete process.env.RAZORPAY_PLAN_PRO;
    const { tenant, user: admin } = await seedOrg("ORG_ADMIN");
    const before = await snapshot(tenant.id, [admin.id]);

    const res = await call(admin.clerkId, { plan: "PRO" });

    expect(res.status).toBe(500);
    await expectUntouched(before, tenant.id, [admin.id]);
  });
});

describe("POST /api/billing/create-subscription — plan validation", () => {
  it.each([
    ["missing", {}],
    ["FREE", { plan: "FREE" }],
    ["lowercase", { plan: "starter" }],
    ["unknown", { plan: "PLATINUM" }],
    ["inherited property constructor", { plan: "constructor" }],
    ["inherited property toString", { plan: "toString" }],
    ["inherited property __proto__", { plan: "__proto__" }],
    ["inherited property hasOwnProperty", { plan: "hasOwnProperty" }],
    ["a number", { plan: 1 }],
    ["null", { plan: null }],
    ["an object", { plan: { toString: "STARTER" } }],
    ["an array", { plan: ["STARTER"] }],
  ])("400s an invalid plan (%s) with no Razorpay call and no row change", async (_label, body) => {
    const { tenant, user: admin } = await seedOrg("ORG_ADMIN");
    const before = await snapshot(tenant.id, [admin.id]);

    const res = await call(admin.clerkId, body);

    expect(res.status).toBe(400);
    await expectUntouched(before, tenant.id, [admin.id]);
  });

  it("400s a body that is not JSON or not an object", async () => {
    const { tenant, user: admin } = await seedOrg("ORG_ADMIN");
    const before = await snapshot(tenant.id, [admin.id]);

    expect((await call(admin.clerkId, "{nope")).status).toBe(400);
    expect((await call(admin.clerkId, "null")).status).toBe(400);
    expect((await call(admin.clerkId, '"STARTER"')).status).toBe(400);
    await expectUntouched(before, tenant.id, [admin.id]);
  });
});

describe("POST /api/billing/create-subscription — seat validation", () => {
  it.each([
    ["a numeric string", '{"plan":"STARTER","seats":"5"}'],
    ["a float", '{"plan":"STARTER","seats":2.5}'],
    ["zero", '{"plan":"STARTER","seats":0}'],
    ["negative", '{"plan":"STARTER","seats":-3}'],
    ["Infinity (1e999 on the wire)", '{"plan":"STARTER","seats":1e999}'],
    ["NaN (serialises to null)", JSON.stringify({ plan: "STARTER", seats: Number.NaN })],
    ["null", '{"plan":"STARTER","seats":null}'],
    ["a boolean", '{"plan":"STARTER","seats":true}'],
    ["an array", '{"plan":"STARTER","seats":[5]}'],
    ["an object", '{"plan":"STARTER","seats":{"valueOf":5}}'],
    ["above the STARTER maximum (11)", '{"plan":"STARTER","seats":11}'],
    ["above the PRO maximum (101)", '{"plan":"PRO","seats":101}'],
    ["a huge number", '{"plan":"PRO","seats":1e21}'],
    ["above the ENTERPRISE ceiling", '{"plan":"ENTERPRISE","seats":1000001}'],
  ])("400s seats that are %s without coercion", async (_label, raw) => {
    const { tenant, user: admin } = await seedOrg("ORG_ADMIN");
    const before = await snapshot(tenant.id, [admin.id]);

    const res = await call(admin.clerkId, raw);

    expect(res.status).toBe(400);
    await expectUntouched(before, tenant.id, [admin.id]);
  });

  it.each([
    ["STARTER", 1],
    ["STARTER", 10],
    ["PRO", 100],
    ["ENTERPRISE", 1000],
    ["ENTERPRISE", 1_000_000],
  ] as const)("accepts %s with %i seats (the plan's own limit)", async (plan, seats) => {
    const { user: admin } = await seedOrg("ORG_ADMIN");

    const res = await call(admin.clerkId, { plan, seats });

    expect(res.status).toBe(200);
    expect(createMock.mock.calls[0][0]).toMatchObject({ quantity: seats });
  });
});

describe("POST /api/billing/create-subscription — existing subscription", () => {
  it.each(["ACTIVE", "PAST_DUE", "PAUSED"] as const)(
    "409s when the current subscription is %s and leaves it unchanged",
    async (status) => {
      const { tenant, user: admin } = await seedOrg("ORG_ADMIN");
      const subId = await seedExistingSubscription(tenant.id, admin.id, status);
      const before = await snapshot(tenant.id, [admin.id]);

      const res = await call(admin.clerkId, { plan: "PRO" });

      expect(res.status).toBe(409);
      await expectUntouched(before, tenant.id, [admin.id]);
      expect((await db.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).razorpaySubId).toBe(
        subId
      );
    }
  );

  it("409s when a different admin of the same organisation owns the live subscription", async () => {
    const { tenant, user: admin } = await seedOrg("ORG_ADMIN");
    const otherAdmin = await createUserInTenant(tenant.id, "ORG_ADMIN");
    const subId = await seedExistingSubscription(tenant.id, otherAdmin.id, "ACTIVE");
    const before = await snapshot(tenant.id, [admin.id, otherAdmin.id]);

    const res = await call(admin.clerkId, { plan: "STARTER" });

    expect(res.status).toBe(409);
    await expectUntouched(before, tenant.id, [admin.id, otherAdmin.id]);
    expect((await db.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).razorpaySubId).toBe(
      subId
    );
  });

  it("allows creation when the organisation has no subscription", async () => {
    const { user: admin } = await seedOrg("ORG_ADMIN");

    const res = await call(admin.clerkId, { plan: "STARTER" });

    expect(res.status).toBe(200);
  });

  it("allows a new subscription to replace a CANCELLED one", async () => {
    const { tenant, user: admin } = await seedOrg("ORG_ADMIN");
    const oldSub = await seedExistingSubscription(tenant.id, admin.id, "CANCELLED");

    const res = await call(admin.clerkId, { plan: "STARTER" });

    expect(res.status).toBe(200);
    const { subscriptionId } = await res.json();
    expect(subscriptionId).not.toBe(oldSub);
    expect((await db.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).razorpaySubId).toBe(
      subscriptionId
    );
    expect((await db.user.findUniqueOrThrow({ where: { id: admin.id } })).razorpaySubId).toBe(
      subscriptionId
    );
  });

  it("allows a retry after an abandoned checkout (a subscription that never activated)", async () => {
    const { tenant, user: admin } = await seedOrg("ORG_ADMIN");
    const abandoned = await seedExistingSubscription(tenant.id, admin.id, null);

    const res = await call(admin.clerkId, { plan: "STARTER" });

    expect(res.status).toBe(200);
    const { subscriptionId } = await res.json();
    expect(subscriptionId).not.toBe(abandoned);
  });
});

describe("POST /api/billing/create-subscription — Razorpay and concurrency", () => {
  it("502s and mutates nothing when Razorpay fails", async () => {
    const { tenant, user: admin } = await seedOrg("ORG_ADMIN");
    const before = await snapshot(tenant.id, [admin.id]);
    createMock.mockRejectedValueOnce(new Error("razorpay down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await call(admin.clerkId, { plan: "STARTER" });

    expect(res.status).toBe(502);
    expect(await snapshot(tenant.id, [admin.id])).toEqual(before);
    expect(cancelMock).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("lets exactly one of two concurrent creations win; the loser gets 409 and its Razorpay subscription is cancelled", async () => {
    const { tenant, user: admin } = await seedOrg("ORG_ADMIN");
    const secondAdmin = await createUserInTenant(tenant.id, "ORG_ADMIN");

    // Hold both requests inside the Razorpay call so each has already read the
    // (empty) subscription id before either tries to record its own.
    let arrived = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const issued: string[] = [];
    createMock.mockImplementation((async () => {
      const id = `sub_race_${Date.now()}_${++subCounter}`;
      issued.push(id);
      arrived += 1;
      if (arrived === 2) release();
      await gate;
      return { id };
    }) as never);

    const [a, b] = await Promise.all([
      call(admin.clerkId, { plan: "STARTER" }),
      call(secondAdmin.clerkId, { plan: "STARTER" }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(issued).toHaveLength(2);

    const winnerRes = a.status === 200 ? a : b;
    const winnerAdmin = a.status === 200 ? admin : secondAdmin;
    const loserAdmin = a.status === 200 ? secondAdmin : admin;
    const { subscriptionId: winnerSub } = await winnerRes.json();
    const loserSub = issued.find((id) => id !== winnerSub);

    expect((await db.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).razorpaySubId).toBe(
      winnerSub
    );
    expect((await db.user.findUniqueOrThrow({ where: { id: winnerAdmin.id } })).razorpaySubId).toBe(
      winnerSub
    );
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: loserAdmin.id } })).razorpaySubId
    ).toBeNull();
    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(cancelMock.mock.calls[0][0]).toBe(loserSub);
  });

  it("does not overwrite a winner recorded between the read and the write", async () => {
    const { tenant, user: admin } = await seedOrg("ORG_ADMIN");
    const winnerSub = `sub_winner_${Date.now()}_${++subCounter}`;
    createMock.mockImplementation((async () => {
      // Another request records its subscription while this one is at Razorpay.
      await db.tenant.update({ where: { id: tenant.id }, data: { razorpaySubId: winnerSub } });
      return { id: `sub_loser_${Date.now()}_${++subCounter}` };
    }) as never);

    const res = await call(admin.clerkId, { plan: "STARTER" });

    expect(res.status).toBe(409);
    expect((await db.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).razorpaySubId).toBe(
      winnerSub
    );
    expect((await db.user.findUniqueOrThrow({ where: { id: admin.id } })).razorpaySubId).toBeNull();
    expect(cancelMock).toHaveBeenCalledTimes(1);
  });

  it("still returns 409 when cancelling the losing subscription itself fails", async () => {
    const { tenant, user: admin } = await seedOrg("ORG_ADMIN");
    createMock.mockImplementation((async () => {
      await db.tenant.update({ where: { id: tenant.id }, data: { razorpaySubId: "sub_won" } });
      return { id: `sub_loser_${Date.now()}_${++subCounter}` };
    }) as never);
    cancelMock.mockRejectedValueOnce(new Error("cancel failed"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await call(admin.clerkId, { plan: "STARTER" });

    expect(res.status).toBe(409);
    errorSpy.mockRestore();
  });
});

describe("POST /api/billing/create-subscription — replacing a CANCELLED subscription (with the downgrade cron)", () => {
  const dueAt = () => new Date(Date.now() - 60_000);

  /** A paid tenant whose subscription owner was cancelled with a due downgrade. */
  async function seedCancelledOwner(tenantId: string, ownerId: string, scheduled: Date | null) {
    const oldSub = `sub_old_${Date.now()}_${++subCounter}`;
    await db.tenant.update({
      where: { id: tenantId },
      data: { plan: "STARTER", seatLimit: 10, razorpaySubId: oldSub },
    });
    await db.user.update({
      where: { id: ownerId },
      data: {
        plan: "STARTER",
        razorpaySubId: oldSub,
        subscriptionStatus: "CANCELLED",
        cancelAtPeriodEnd: false,
        scheduledDowngradeAt: scheduled,
      },
    });
    return oldSub;
  }

  function cronRequest() {
    return new NextRequest("http://localhost/api/cron/downgrade-subscriptions", {
      headers: { authorization: "Bearer cron-secret-test" },
    });
  }

  async function sendWebhook(event: string, entity: Record<string, unknown>) {
    const raw = JSON.stringify({ event, payload: { subscription: { entity } } });
    const signature = crypto.createHmac("sha256", "webhook-secret-test").update(raw).digest("hex");
    const res = await razorpayWebhook(
      new Request("http://localhost/api/webhooks/razorpay", {
        method: "POST",
        body: raw,
        headers: { "x-razorpay-signature": signature },
      })
    );
    expect(res.status).toBe(200);
  }

  async function activate(subscriptionId: string, clerkId: string) {
    await sendWebhook("subscription.activated", {
      id: subscriptionId,
      current_end: Math.floor(Date.now() / 1000) + 30 * 86400,
      notes: { userId: clerkId, plan: "STARTER" },
    });
  }

  /** A late or replayed subscription.cancelled for the superseded subscription. */
  async function replayCancellation(oldSub: string, clerkId: string) {
    await sendWebhook("subscription.cancelled", {
      id: oldSub,
      current_end: Math.floor(Date.now() / 1000) - 3600,
      notes: { userId: clerkId, plan: "STARTER" },
    });
  }

  async function expectPaidOn(tenantId: string, subscriptionId: string) {
    const after = await db.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    expect(after.razorpaySubId).toBe(subscriptionId);
    expect(after.plan).toBe("STARTER");
    expect(after.seatLimit).toBe(10);
  }

  async function expectDowngraded(tenantId: string) {
    const after = await db.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    expect(after.plan).toBe("FREE");
    expect(after.seatLimit).toBe(3);
    expect(after.razorpaySubId).toBeNull();
  }

  it("leaves the superseded owner's cancellation record alone: the cron, not creation, decides", async () => {
    const { tenant, user: oldOwner } = await seedOrg("ORG_ADMIN");
    const due = dueAt();
    const oldSub = await seedCancelledOwner(tenant.id, oldOwner.id, due);
    const newAdmin = await createUserInTenant(tenant.id, "ORG_ADMIN");

    const res = await call(newAdmin.clerkId, { plan: "STARTER" });

    expect(res.status).toBe(200);
    const { subscriptionId } = await res.json();
    expect((await db.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).razorpaySubId).toBe(
      subscriptionId
    );
    expect((await db.user.findUniqueOrThrow({ where: { id: newAdmin.id } })).razorpaySubId).toBe(
      subscriptionId
    );
    const superseded = await db.user.findUniqueOrThrow({ where: { id: oldOwner.id } });
    expect(superseded.scheduledDowngradeAt?.getTime()).toBe(due.getTime());
    expect(superseded.subscriptionStatus).toBe("CANCELLED");
    expect(superseded.razorpaySubId).toBe(oldSub);
    expect(superseded.plan).toBe("STARTER");
  });

  it("an activated replacement survives the downgrade cron (the F1 reproduction)", async () => {
    const { tenant, user: oldOwner } = await seedOrg("ORG_ADMIN");
    await seedCancelledOwner(tenant.id, oldOwner.id, dueAt());
    const newAdmin = await createUserInTenant(tenant.id, "ORG_ADMIN");

    const res = await call(newAdmin.clerkId, { plan: "STARTER" });
    expect(res.status).toBe(200);
    const { subscriptionId } = await res.json();
    await activate(subscriptionId, newAdmin.clerkId);

    const cronRes = await runDowngradeCron(cronRequest());
    expect(cronRes.status).toBe(200);

    await expectPaidOn(tenant.id, subscriptionId);
    const owner = await db.user.findUniqueOrThrow({ where: { id: newAdmin.id } });
    expect(owner.razorpaySubId).toBe(subscriptionId);
    expect(owner.plan).toBe("STARTER");
    expect(owner.subscriptionStatus).toBe("ACTIVE");
    // The stale record is retired by the cron, not applied.
    const old = await db.user.findUniqueOrThrow({ where: { id: oldOwner.id } });
    expect(old.scheduledDowngradeAt).toBeNull();
  });

  it("an activated same-admin replacement survives the downgrade cron", async () => {
    const { tenant, user: admin } = await seedOrg("ORG_ADMIN");
    await seedCancelledOwner(tenant.id, admin.id, dueAt());

    const res = await call(admin.clerkId, { plan: "STARTER" });
    expect(res.status).toBe(200);
    const { subscriptionId } = await res.json();
    await activate(subscriptionId, admin.clerkId);

    await runDowngradeCron(cronRequest());

    await expectPaidOn(tenant.id, subscriptionId);
    const row = await db.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(row.subscriptionStatus).toBe("ACTIVE");
    expect(row.razorpaySubId).toBe(subscriptionId);
  });

  it("an abandoned replacement no longer leaves the tenant paid forever (N1, different admin)", async () => {
    const { tenant, user: oldOwner } = await seedOrg("ORG_ADMIN");
    await seedCancelledOwner(tenant.id, oldOwner.id, dueAt());
    const newAdmin = await createUserInTenant(tenant.id, "ORG_ADMIN");

    const res = await call(newAdmin.clerkId, { plan: "STARTER" });
    expect(res.status).toBe(200);
    // Checkout is abandoned: no activation webhook ever arrives.
    await runDowngradeCron(cronRequest());
    await runDowngradeCron(cronRequest());

    await expectDowngraded(tenant.id);
    for (const id of [oldOwner.id, newAdmin.id]) {
      expect((await db.user.findUniqueOrThrow({ where: { id } })).plan).toBe("FREE");
    }
  });

  it("an abandoned replacement no longer leaves the tenant paid forever (N1, same admin)", async () => {
    const { tenant, user: admin } = await seedOrg("ORG_ADMIN");
    await seedCancelledOwner(tenant.id, admin.id, dueAt());

    const res = await call(admin.clerkId, { plan: "STARTER" });
    expect(res.status).toBe(200);
    await runDowngradeCron(cronRequest());

    await expectDowngraded(tenant.id);
    expect((await db.user.findUniqueOrThrow({ where: { id: admin.id } })).plan).toBe("FREE");
  });

  it("a replayed cancellation of the superseded subscription does not downgrade the live replacement (F3 defense)", async () => {
    const { tenant, user: oldOwner } = await seedOrg("ORG_ADMIN");
    const oldSub = await seedCancelledOwner(tenant.id, oldOwner.id, dueAt());
    const newAdmin = await createUserInTenant(tenant.id, "ORG_ADMIN");
    const res = await call(newAdmin.clerkId, { plan: "STARTER" });
    const { subscriptionId } = await res.json();
    await activate(subscriptionId, newAdmin.clerkId);
    await runDowngradeCron(cronRequest());

    await replayCancellation(oldSub, oldOwner.clerkId);
    const rearmed = await db.user.findUniqueOrThrow({ where: { id: oldOwner.id } });
    expect(rearmed.scheduledDowngradeAt).not.toBeNull();
    await runDowngradeCron(cronRequest());

    await expectPaidOn(tenant.id, subscriptionId);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: newAdmin.id } })).subscriptionStatus
    ).toBe("ACTIVE");
  });

  it("a replayed cancellation does not keep a never-activated replacement paid", async () => {
    const { tenant, user: oldOwner } = await seedOrg("ORG_ADMIN");
    const oldSub = await seedCancelledOwner(tenant.id, oldOwner.id, dueAt());
    const newAdmin = await createUserInTenant(tenant.id, "ORG_ADMIN");
    expect((await call(newAdmin.clerkId, { plan: "STARTER" })).status).toBe(200);

    await replayCancellation(oldSub, oldOwner.clerkId);
    await runDowngradeCron(cronRequest());

    await expectDowngraded(tenant.id);
  });

  it("modifies only the tenant's subscription id and the caller's own: no other user row changes", async () => {
    const { tenant, user: oldOwner } = await seedOrg("ORG_ADMIN");
    const oldSub = await seedCancelledOwner(tenant.id, oldOwner.id, dueAt());
    const bystanderDue = dueAt();
    const others = [oldOwner.id];
    // Another cancelled user with a different subscription id.
    const otherSub = await createUserInTenant(tenant.id, "STUDENT");
    await db.user.update({
      where: { id: otherSub.id },
      data: {
        razorpaySubId: "sub_bystander",
        subscriptionStatus: "CANCELLED",
        scheduledDowngradeAt: bystanderDue,
      },
    });
    // Another cancelled user with no subscription id at all.
    const noSub = await createUserInTenant(tenant.id, "STUDENT");
    await db.user.update({
      where: { id: noSub.id },
      data: { subscriptionStatus: "CANCELLED", scheduledDowngradeAt: bystanderDue },
    });
    // A second holder of the replaced id whose status is not CANCELLED (the schema
    // has no uniqueness on User.razorpaySubId), with a marker date that must survive.
    const duplicate = await createUserInTenant(tenant.id, "ORG_ADMIN");
    await db.user.update({
      where: { id: duplicate.id },
      data: { razorpaySubId: oldSub, subscriptionStatus: null, scheduledDowngradeAt: bystanderDue },
    });
    others.push(otherSub.id, noSub.id, duplicate.id);
    const caller = await createUserInTenant(tenant.id, "ORG_ADMIN");
    const before = await snapshot(tenant.id, others);

    const res = await call(caller.clerkId, { plan: "STARTER" });

    expect(res.status).toBe(200);
    const after = await snapshot(tenant.id, others);
    expect(after.users).toEqual(before.users);
  });

  it("with no previous subscription, leaves a cancelled user that holds no subscription id untouched", async () => {
    const { tenant, user: admin } = await seedOrg("ORG_ADMIN");
    const marker = dueAt();
    const noSub = await createUserInTenant(tenant.id, "STUDENT");
    await db.user.update({
      where: { id: noSub.id },
      data: { razorpaySubId: null, subscriptionStatus: "CANCELLED", scheduledDowngradeAt: marker },
    });
    expect(
      (await db.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).razorpaySubId
    ).toBeNull();
    const before = await snapshot(tenant.id, [noSub.id]);

    const res = await call(admin.clerkId, { plan: "STARTER" });

    expect(res.status).toBe(200);
    expect((await snapshot(tenant.id, [noSub.id])).users).toEqual(before.users);
  });

  it("does not touch another tenant's cancelled owner, even one carrying the same subscription id", async () => {
    const { tenant, user: oldOwner } = await seedOrg("ORG_ADMIN");
    const oldSub = await seedCancelledOwner(tenant.id, oldOwner.id, dueAt());
    const { tenant: otherTenant, user: otherOwner } = await seedOrg("ORG_ADMIN");
    await seedCancelledOwner(otherTenant.id, otherOwner.id, dueAt());
    const { user: foreign } = await seedOrg("ORG_ADMIN");
    await db.user.update({
      where: { id: foreign.id },
      data: {
        razorpaySubId: oldSub,
        subscriptionStatus: "CANCELLED",
        scheduledDowngradeAt: dueAt(),
      },
    });
    const newAdmin = await createUserInTenant(tenant.id, "ORG_ADMIN");
    const before = await snapshot(otherTenant.id, [otherOwner.id, foreign.id]);

    const res = await call(newAdmin.clerkId, { plan: "STARTER" });

    expect(res.status).toBe(200);
    expect(await snapshot(otherTenant.id, [otherOwner.id, foreign.id])).toEqual(before);
  });

  it("does not modify the replaced record when it has no local status (null-status replacement)", async () => {
    const { tenant, user: owner } = await seedOrg("ORG_ADMIN");
    const abandoned = await seedExistingSubscription(tenant.id, owner.id, null);
    const marker = dueAt();
    await db.user.update({ where: { id: owner.id }, data: { scheduledDowngradeAt: marker } });
    const newAdmin = await createUserInTenant(tenant.id, "ORG_ADMIN");

    const res = await call(newAdmin.clerkId, { plan: "STARTER" });

    expect(res.status).toBe(200);
    const row = await db.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(row.scheduledDowngradeAt?.getTime()).toBe(marker.getTime());
    expect(row.razorpaySubId).toBe(abandoned);
    expect(row.subscriptionStatus).toBeNull();
  });

  it.each(["ACTIVE", "PAST_DUE", "PAUSED"] as const)(
    "a %s subscription still 409s and its owner's fields are not touched",
    async (status) => {
      const { tenant, user: owner } = await seedOrg("ORG_ADMIN");
      await seedExistingSubscription(tenant.id, owner.id, status);
      const marker = dueAt();
      await db.user.update({ where: { id: owner.id }, data: { scheduledDowngradeAt: marker } });
      const before = await snapshot(tenant.id, [owner.id]);

      const res = await call(owner.clerkId, { plan: "STARTER" });

      expect(res.status).toBe(409);
      await expectUntouched(before, tenant.id, [owner.id]);
    }
  );

  it("keeps one winner when two admins race to replace a CANCELLED subscription, and the winner survives the cron", async () => {
    const { tenant, user: oldOwner } = await seedOrg("ORG_ADMIN");
    const due = dueAt();
    await seedCancelledOwner(tenant.id, oldOwner.id, due);
    const adminA = await createUserInTenant(tenant.id, "ORG_ADMIN");
    const adminB = await createUserInTenant(tenant.id, "ORG_ADMIN");
    const bystander = await createUserInTenant(tenant.id, "STUDENT");
    const bystanderDue = dueAt();
    await db.user.update({
      where: { id: bystander.id },
      data: {
        razorpaySubId: "sub_bystander",
        subscriptionStatus: "CANCELLED",
        scheduledDowngradeAt: bystanderDue,
      },
    });

    let arrived = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const issued: string[] = [];
    createMock.mockImplementation((async () => {
      const id = `sub_race2_${Date.now()}_${++subCounter}`;
      issued.push(id);
      arrived += 1;
      if (arrived === 2) release();
      await gate;
      return { id };
    }) as never);

    const [a, b] = await Promise.all([
      call(adminA.clerkId, { plan: "STARTER" }),
      call(adminB.clerkId, { plan: "STARTER" }),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winner = a.status === 200 ? adminA : adminB;
    const loser = a.status === 200 ? adminB : adminA;
    const { subscriptionId: winnerSub } = await (a.status === 200 ? a : b).json();
    const loserSub = issued.find((id) => id !== winnerSub);

    expect((await db.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).razorpaySubId).toBe(
      winnerSub
    );
    expect((await db.user.findUniqueOrThrow({ where: { id: winner.id } })).razorpaySubId).toBe(
      winnerSub
    );
    expect((await db.user.findUniqueOrThrow({ where: { id: loser.id } })).razorpaySubId).toBeNull();
    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(cancelMock.mock.calls[0][0]).toBe(loserSub);
    expect(
      (
        await db.user.findUniqueOrThrow({ where: { id: oldOwner.id } })
      ).scheduledDowngradeAt?.getTime()
    ).toBe(due.getTime());
    const untouched = await db.user.findUniqueOrThrow({ where: { id: bystander.id } });
    expect(untouched.scheduledDowngradeAt?.getTime()).toBe(bystanderDue.getTime());

    await activate(winnerSub, winner.clerkId);
    await runDowngradeCron(cronRequest());
    await expectPaidOn(tenant.id, winnerSub);
  });

  it("a request that loses the compare-and-set changes no user row", async () => {
    const { tenant, user: oldOwner } = await seedOrg("ORG_ADMIN");
    const due = dueAt();
    await seedCancelledOwner(tenant.id, oldOwner.id, due);
    const admin = await createUserInTenant(tenant.id, "ORG_ADMIN");
    const winnerSub = `sub_winner_${Date.now()}_${++subCounter}`;
    createMock.mockImplementation((async () => {
      // Another request records its own subscription while this one is at Razorpay.
      await db.tenant.update({ where: { id: tenant.id }, data: { razorpaySubId: winnerSub } });
      return { id: `sub_loser_${Date.now()}_${++subCounter}` };
    }) as never);

    const res = await call(admin.clerkId, { plan: "STARTER" });

    expect(res.status).toBe(409);
    expect((await db.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).razorpaySubId).toBe(
      winnerSub
    );
    const row = await db.user.findUniqueOrThrow({ where: { id: oldOwner.id } });
    expect(row.scheduledDowngradeAt?.getTime()).toBe(due.getTime());
    expect((await db.user.findUniqueOrThrow({ where: { id: admin.id } })).razorpaySubId).toBeNull();
    expect(cancelMock).toHaveBeenCalledTimes(1);
  });

  it("rolls back everything when the transaction fails", async () => {
    const { tenant, user: oldOwner } = await seedOrg("ORG_ADMIN");
    const due = dueAt();
    const oldSub = await seedCancelledOwner(tenant.id, oldOwner.id, due);
    const caller = await createUserInTenant(tenant.id, "ORG_ADMIN");
    const newSub = `sub_rollback_${Date.now()}_${++subCounter}`;
    createMock.mockImplementation((async () => {
      // The caller row vanishes mid-request, so the transaction's user update
      // throws AFTER the tenant compare-and-set already ran.
      await db.user.delete({ where: { id: caller.id } });
      return { id: newSub };
    }) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await call(caller.clerkId, { plan: "STARTER" });
    errorSpy.mockRestore();

    expect(res.status).toBe(500);
    expect((await db.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).razorpaySubId).toBe(
      oldSub
    );
    const owner = await db.user.findUniqueOrThrow({ where: { id: oldOwner.id } });
    expect(owner.scheduledDowngradeAt?.getTime()).toBe(due.getTime());
    expect(owner.razorpaySubId).toBe(oldSub);
    expect(owner.subscriptionStatus).toBe("CANCELLED");
    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(cancelMock.mock.calls[0][0]).toBe(newSub);
  });

  it("still 502s and changes nothing when Razorpay fails", async () => {
    const { tenant, user: oldOwner } = await seedOrg("ORG_ADMIN");
    const due = dueAt();
    const oldSub = await seedCancelledOwner(tenant.id, oldOwner.id, due);
    const admin = await createUserInTenant(tenant.id, "ORG_ADMIN");
    createMock.mockRejectedValueOnce(new Error("razorpay down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await call(admin.clerkId, { plan: "STARTER" });
    errorSpy.mockRestore();

    expect(res.status).toBe(502);
    expect((await db.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).razorpaySubId).toBe(
      oldSub
    );
    const owner = await db.user.findUniqueOrThrow({ where: { id: oldOwner.id } });
    expect(owner.scheduledDowngradeAt?.getTime()).toBe(due.getTime());
    expect(cancelMock).not.toHaveBeenCalled();
  });
});
