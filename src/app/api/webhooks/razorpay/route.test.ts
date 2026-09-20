import crypto from "node:crypto";
import { auth } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { createSoloUser, createUserInTenant } from "@/lib/domain/course/__test__/fixtures";
import { createTenantUser } from "@/lib/domain/knowledge/__test__/fixtures";

/**
 * POST /api/webhooks/razorpay — subscription.activated — against the REAL
 * database, with the real create-subscription, downgrade cron, cancel,
 * reactivate and change-plan routes for the recovery flows. Only Clerk, Razorpay
 * and Resend are mocked.
 */
vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));
vi.mock("@/lib/razorpay", () => ({
  razorpay: { subscriptions: { create: vi.fn(), cancel: vi.fn(), update: vi.fn() } },
}));
vi.mock("@/lib/resend", () => ({ resend: { emails: { send: vi.fn().mockResolvedValue({}) } } }));

// change-plan reads its plan ids when the module loads, so these are set first.
const ENV_KEYS = [
  "RAZORPAY_PLAN_STARTER",
  "RAZORPAY_PLAN_PRO",
  "RAZORPAY_PLAN_ENTERPRISE",
  "NEXT_PUBLIC_RAZORPAY_KEY_ID",
  "CRON_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
process.env.RAZORPAY_PLAN_STARTER = "plan_starter_wh";
process.env.RAZORPAY_PLAN_PRO = "plan_pro_wh";
process.env.RAZORPAY_PLAN_ENTERPRISE = "plan_enterprise_wh";
process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = "rzp_test_key";
process.env.CRON_SECRET = "cron-secret-test";
process.env.RAZORPAY_WEBHOOK_SECRET = "webhook-secret-test";

const { razorpay } = await import("@/lib/razorpay");
const { POST: razorpayWebhook } = await import("./route");
const { POST: createSubscription } = await import("@/app/api/billing/create-subscription/route");
const { POST: cancelSubscription } = await import("@/app/api/billing/cancel/route");
const { POST: reactivateSubscription } = await import("@/app/api/billing/reactivate/route");
const { POST: changePlan } = await import("@/app/api/billing/change-plan/route");
const { GET: runDowngradeCron } = await import("@/app/api/cron/downgrade-subscriptions/route");

const createMock = vi.mocked(razorpay.subscriptions.create);
const cancelMock = vi.mocked(razorpay.subscriptions.cancel);
const updateMock = vi.mocked(razorpay.subscriptions.update);

let counter = 0;
const subId = (label: string) => `sub_${label}_${Date.now()}_${++counter}`;
const dueAt = () => new Date(Date.now() - 60_000);
const futureEnd = () => Math.floor(Date.now() / 1000) + 30 * 86_400;

beforeEach(() => {
  createMock.mockReset();
  cancelMock.mockReset();
  updateMock.mockReset();
  createMock.mockImplementation((async () => ({ id: subId("created") })) as never);
  cancelMock.mockResolvedValue({} as never);
  updateMock.mockResolvedValue({} as never);
});

afterEach(() => {
  vi.mocked(auth).mockReset();
});

afterAll(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await db.$disconnect();
});

function signedRequest(raw: string, signature?: string) {
  return new Request("http://localhost/api/webhooks/razorpay", {
    method: "POST",
    body: raw,
    headers: {
      "x-razorpay-signature":
        signature ?? crypto.createHmac("sha256", "webhook-secret-test").update(raw).digest("hex"),
    },
  });
}

function activatedBody(entity: Record<string, unknown>) {
  return JSON.stringify({ event: "subscription.activated", payload: { subscription: { entity } } });
}

async function activate(
  subscriptionId: string | undefined,
  clerkId: string,
  plan = "STARTER",
  currentEnd: number | null = futureEnd()
) {
  const res = await razorpayWebhook(
    signedRequest(
      activatedBody({
        ...(subscriptionId ? { id: subscriptionId } : {}),
        current_end: currentEnd,
        notes: { userId: clerkId, plan },
      })
    )
  );
  expect(res.status).toBe(200);
}

function call(handler: (req: Request) => Promise<Response>, clerkId: string, body: unknown = {}) {
  vi.mocked(auth).mockResolvedValue({ userId: clerkId } as never);
  return handler(
    new Request("http://localhost/api/billing", { method: "POST", body: JSON.stringify(body) })
  );
}

function cronRequest() {
  return new NextRequest("http://localhost/api/cron/downgrade-subscriptions", {
    headers: { authorization: "Bearer cron-secret-test" },
  });
}

const tenantRow = (id: string) => db.tenant.findUniqueOrThrow({ where: { id } });
const userRow = (id: string) => db.user.findUniqueOrThrow({ where: { id } });

/** A tenant with `pointer` as its current subscription, `admin` being an ORG_ADMIN in it. */
async function org(pointer: string | null, plan: "FREE" | "STARTER" = "FREE") {
  const { tenant, user: admin } = await createTenantUser("ORG_ADMIN");
  await db.tenant.update({
    where: { id: tenant.id },
    data: { plan, seatLimit: plan === "FREE" ? 3 : 10, razorpaySubId: pointer },
  });
  return { tenant, admin };
}

/** Subscription A: owned by `ownerId`, CANCELLED with a due downgrade, current on the tenant. */
async function seedCancelledOwner(tenantId: string, ownerId: string) {
  const oldSub = subId("old");
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
      scheduledDowngradeAt: dueAt(),
    },
  });
  return oldSub;
}

describe("subscription.activated — existing behavior is unchanged", () => {
  it("activates the subscriber and moves the whole tenant to the plan and its seat limit", async () => {
    const { tenant, admin } = await org(null);
    const member = await createUserInTenant(tenant.id, "STUDENT");
    const { tenant: other, admin: outsider } = await org(null);
    const end = futureEnd();

    await activate(subId("plain"), admin.clerkId, "PRO", end);

    const subscriber = await userRow(admin.id);
    expect(subscriber.plan).toBe("PRO");
    expect(subscriber.subscriptionStatus).toBe("ACTIVE");
    expect(subscriber.currentPeriodEnd?.getTime()).toBe(end * 1000);
    expect((await userRow(member.id)).plan).toBe("PRO");
    const row = await tenantRow(tenant.id);
    expect(row.plan).toBe("PRO");
    expect(row.seatLimit).toBe(100);
    // Another organisation is not touched.
    expect((await tenantRow(other.id)).plan).toBe("FREE");
    expect((await userRow(outsider.id)).plan).toBe("FREE");
    expect((await userRow(outsider.id)).subscriptionStatus).toBeNull();
  });

  it("rejects a bad signature and changes nothing", async () => {
    const { tenant, admin } = await org(null);

    const res = await razorpayWebhook(
      signedRequest(
        activatedBody({ id: subId("x"), notes: { userId: admin.clerkId, plan: "STARTER" } }),
        "0".repeat(64)
      )
    );

    expect(res.status).toBe(400);
    expect((await tenantRow(tenant.id)).razorpaySubId).toBeNull();
    expect((await userRow(admin.id)).subscriptionStatus).toBeNull();
  });

  it.each([
    ["no notes", undefined],
    ["a plan that is not paid", { userId: "PLACEHOLDER", plan: "FREE" }],
    ["an unknown user", { userId: "clerk-does-not-exist", plan: "STARTER" }],
  ] as const)("ignores an event with %s", async (_label, notes) => {
    const { tenant, admin } = await org(null);
    const resolved =
      notes && notes.userId === "PLACEHOLDER" ? { ...notes, userId: admin.clerkId } : notes;

    const res = await razorpayWebhook(
      signedRequest(activatedBody({ id: subId("ignored"), notes: resolved }))
    );

    expect(res.status).toBe(200);
    expect((await tenantRow(tenant.id)).razorpaySubId).toBeNull();
    expect((await tenantRow(tenant.id)).plan).toBe("FREE");
    expect((await userRow(admin.id)).subscriptionStatus).toBeNull();
  });

  it("activates a subscriber with no organisation without writing any subscription pointer", async () => {
    const solo = await createSoloUser("STUDENT");

    await activate(subId("solo"), solo.clerkId, "STARTER");

    const row = await userRow(solo.id);
    expect(row.plan).toBe("STARTER");
    expect(row.subscriptionStatus).toBe("ACTIVE");
    expect(row.razorpaySubId).toBeNull();
  });

  it("still applies the plan when the event carries no subscription id, recording no pointer", async () => {
    const { tenant, admin } = await org(null);

    await activate(undefined, admin.clerkId, "STARTER");

    expect((await tenantRow(tenant.id)).plan).toBe("STARTER");
    expect((await tenantRow(tenant.id)).razorpaySubId).toBeNull();
    expect((await userRow(admin.id)).razorpaySubId).toBeNull();
    expect((await userRow(admin.id)).subscriptionStatus).toBe("ACTIVE");
  });
});

describe("subscription.activated — subscription pointer (null-only)", () => {
  it("records the subscription on the tenant and the subscriber when the tenant pointer is null", async () => {
    const { tenant, admin } = await org(null);
    const id = subId("restore");

    await activate(id, admin.clerkId);

    expect((await tenantRow(tenant.id)).razorpaySubId).toBe(id);
    expect((await userRow(admin.id)).razorpaySubId).toBe(id);
    expect((await userRow(admin.id)).subscriptionStatus).toBe("ACTIVE");
    expect((await tenantRow(tenant.id)).plan).toBe("STARTER");
    expect((await tenantRow(tenant.id)).seatLimit).toBe(10);
  });

  it("never overwrites a non-null tenant pointer, nor the pointer on a subscriber who holds it", async () => {
    const current = subId("current");
    const { tenant, admin } = await org(current, "STARTER");
    await db.user.update({ where: { id: admin.id }, data: { razorpaySubId: current } });

    await activate(subId("other"), admin.clerkId);

    expect((await tenantRow(tenant.id)).razorpaySubId).toBe(current);
    expect((await userRow(admin.id)).razorpaySubId).toBe(current);
  });

  it("a stale activation for a superseded subscription does not replace the current one (different admin)", async () => {
    const { tenant, admin: oldOwner } = await org(null);
    const oldSub = await seedCancelledOwner(tenant.id, oldOwner.id);
    const newAdmin = await createUserInTenant(tenant.id, "ORG_ADMIN");
    const newSub = subId("new");
    await db.tenant.update({ where: { id: tenant.id }, data: { razorpaySubId: newSub } });
    await db.user.update({
      where: { id: newAdmin.id },
      data: { razorpaySubId: newSub, subscriptionStatus: "ACTIVE" },
    });

    await activate(oldSub, oldOwner.clerkId);

    expect((await tenantRow(tenant.id)).razorpaySubId).toBe(newSub);
    const current = await userRow(newAdmin.id);
    expect(current.razorpaySubId).toBe(newSub);
    expect(current.subscriptionStatus).toBe("ACTIVE");
    // The superseded owner keeps its own historical id. (What the event does to
    // that owner's status and to the plan follows the existing handler — F3.)
    expect((await userRow(oldOwner.id)).razorpaySubId).toBe(oldSub);
  });

  it("a stale activation does not replace the current subscription (same admin)", async () => {
    const { tenant, admin } = await org(null);
    const oldSub = subId("stale");
    const newSub = subId("live");
    await db.tenant.update({
      where: { id: tenant.id },
      data: { plan: "STARTER", seatLimit: 10, razorpaySubId: newSub },
    });
    await db.user.update({
      where: { id: admin.id },
      data: { razorpaySubId: newSub, subscriptionStatus: "ACTIVE" },
    });

    await activate(oldSub, admin.clerkId);

    expect((await tenantRow(tenant.id)).razorpaySubId).toBe(newSub);
    expect((await userRow(admin.id)).razorpaySubId).toBe(newSub);
  });

  it("is idempotent: a duplicate activation for the current subscription changes nothing further", async () => {
    const { tenant, admin } = await org(null);
    const id = subId("dup");
    const end = futureEnd();

    await activate(id, admin.clerkId, "STARTER", end);
    const first = { tenant: await tenantRow(tenant.id), user: await userRow(admin.id) };
    await activate(id, admin.clerkId, "STARTER", end);

    expect(await tenantRow(tenant.id)).toEqual({ ...first.tenant, updatedAt: expect.any(Date) });
    const second = await userRow(admin.id);
    expect({ ...second, updatedAt: null }).toEqual({ ...first.user, updatedAt: null });
    expect(second.razorpaySubId).toBe(id);
    expect((await tenantRow(tenant.id)).razorpaySubId).toBe(id);
  });

  it("heals a subscriber whose own pointer is empty when the tenant already points at this subscription", async () => {
    const id = subId("partial");
    const { tenant, admin } = await org(id, "STARTER");
    expect((await userRow(admin.id)).razorpaySubId).toBeNull();

    await activate(id, admin.clerkId);

    expect((await tenantRow(tenant.id)).razorpaySubId).toBe(id);
    expect((await userRow(admin.id)).razorpaySubId).toBe(id);
  });

  it("cannot write into another organisation: only the subscriber's own tenant is restored", async () => {
    const { tenant: tenantB, admin: userB } = await org(null);
    const { tenant: tenantA, admin: userA } = await org(null);
    const id = subId("isolated");

    await activate(id, userB.clerkId);

    expect((await tenantRow(tenantB.id)).razorpaySubId).toBe(id);
    const untouched = await tenantRow(tenantA.id);
    expect(untouched.razorpaySubId).toBeNull();
    expect(untouched.plan).toBe("FREE");
    expect((await userRow(userA.id)).razorpaySubId).toBeNull();
    expect((await userRow(userA.id)).subscriptionStatus).toBeNull();
  });
});

describe("recovery after the downgrade cron ran before the replacement activated", () => {
  async function createReplacement(clerkId: string) {
    const res = await call(createSubscription, clerkId, { plan: "STARTER" });
    expect(res.status).toBe(200);
    const { subscriptionId } = (await res.json()) as { subscriptionId: string };
    return subscriptionId;
  }

  async function expectRecovered(tenantId: string, ownerId: string, newSub: string) {
    const tenant = await tenantRow(tenantId);
    expect(tenant.plan).toBe("STARTER");
    expect(tenant.seatLimit).toBe(10);
    expect(tenant.razorpaySubId).toBe(newSub);
    const owner = await userRow(ownerId);
    expect(owner.razorpaySubId).toBe(newSub);
    expect(owner.subscriptionStatus).toBe("ACTIVE");
    expect(owner.plan).toBe("STARTER");
    expect(owner.currentPeriodEnd).not.toBeNull();
  }

  /** cancel finds the owner through the tenant pointer; reactivate and change-plan follow. */
  async function expectManageable(
    tenantId: string,
    ownerId: string,
    caller: string,
    newSub: string
  ) {
    const cancelRes = await call(cancelSubscription, caller);
    expect(cancelRes.status).toBe(200);
    expect(cancelMock).toHaveBeenCalledWith(newSub, 1);
    const owner = await userRow(ownerId);
    expect(owner.cancelAtPeriodEnd).toBe(true);
    expect((await cancelRes.json()).cancellationDate).toBe(owner.currentPeriodEnd?.toISOString());

    const reactivateRes = await call(reactivateSubscription, caller);
    expect(reactivateRes.status).toBe(200);
    expect((await userRow(ownerId)).cancelAtPeriodEnd).toBe(false);

    const changeRes = await call(changePlan, caller, { newPlan: "PRO" });
    expect(changeRes.status).toBe(200);
    expect(updateMock).toHaveBeenCalledWith(newSub, {
      plan_id: "plan_pro_wh",
      schedule_change_at: "cycle_end",
    });
    const tenant = await tenantRow(tenantId);
    expect(tenant.plan).toBe("PRO");
    expect(tenant.seatLimit).toBe(100);
  }

  it("same admin: the cron clears both pointers, the activation restores both, and billing works", async () => {
    const { tenant, admin } = await org(null);
    await seedCancelledOwner(tenant.id, admin.id);
    const newSub = await createReplacement(admin.clerkId);

    await runDowngradeCron(cronRequest());
    const cleared = await tenantRow(tenant.id);
    expect(cleared.plan).toBe("FREE");
    expect(cleared.razorpaySubId).toBeNull();
    expect((await userRow(admin.id)).razorpaySubId).toBeNull();

    await activate(newSub, admin.clerkId);

    await expectRecovered(tenant.id, admin.id, newSub);
    await expectManageable(tenant.id, admin.id, admin.clerkId, newSub);
  });

  it("different admin: the new owner is restored, the old owner stays historical, and billing works", async () => {
    const { tenant, admin: oldOwner } = await org(null);
    const oldSub = await seedCancelledOwner(tenant.id, oldOwner.id);
    const newAdmin = await createUserInTenant(tenant.id, "ORG_ADMIN");
    const newSub = await createReplacement(newAdmin.clerkId);

    await runDowngradeCron(cronRequest());
    expect((await tenantRow(tenant.id)).razorpaySubId).toBeNull();
    expect((await tenantRow(tenant.id)).plan).toBe("FREE");

    await activate(newSub, newAdmin.clerkId);

    await expectRecovered(tenant.id, newAdmin.id, newSub);
    // No stale state from the cancelled subscription comes back.
    const old = await userRow(oldOwner.id);
    expect(old.subscriptionStatus).toBeNull();
    expect(old.scheduledDowngradeAt).toBeNull();
    expect(old.razorpaySubId).toBeNull();
    expect(old.razorpaySubId).not.toBe(oldSub);
    // Any admin of the organisation reaches the current subscription.
    await expectManageable(tenant.id, newAdmin.id, oldOwner.clerkId, newSub);
  });

  it("the recovered tenant is no longer blind to its live subscription: a second create is refused", async () => {
    const { tenant, admin } = await org(null);
    await seedCancelledOwner(tenant.id, admin.id);
    const newSub = await createReplacement(admin.clerkId);
    await runDowngradeCron(cronRequest());
    await activate(newSub, admin.clerkId);
    createMock.mockClear();

    const res = await call(createSubscription, admin.clerkId, { plan: "STARTER" });

    expect(res.status).toBe(409);
    expect(createMock).not.toHaveBeenCalled();
    expect((await tenantRow(tenant.id)).razorpaySubId).toBe(newSub);
  });

  it("a normal activation with no cron in between still works end to end", async () => {
    const { tenant, admin } = await org(null);
    await seedCancelledOwner(tenant.id, admin.id);
    const newSub = await createReplacement(admin.clerkId);

    await activate(newSub, admin.clerkId);
    await runDowngradeCron(cronRequest());

    await expectRecovered(tenant.id, admin.id, newSub);
  });
});

describe("races", () => {
  it("two activation deliveries for the same subscription arriving together leave one consistent pointer", async () => {
    const { tenant, admin } = await org(null);
    const id = subId("twice");
    const end = futureEnd();

    await Promise.all([
      activate(id, admin.clerkId, "STARTER", end),
      activate(id, admin.clerkId, "STARTER", end),
    ]);

    const row = await tenantRow(tenant.id);
    expect(row.razorpaySubId).toBe(id);
    expect(row.plan).toBe("STARTER");
    expect((await userRow(admin.id)).razorpaySubId).toBe(id);
    expect((await userRow(admin.id)).subscriptionStatus).toBe("ACTIVE");
  });

  it("an activation racing create-subscription never overwrites the pointer the other recorded", async () => {
    let restoredByActivation = 0;
    let recordedByCreate = 0;

    for (let i = 0; i < 6; i += 1) {
      const { tenant, admin: activating } = await org(null);
      const creator = await createUserInTenant(tenant.id, "ORG_ADMIN");
      const activated = subId("race-b");
      const created = subId("race-c");
      createMock.mockReset();
      cancelMock.mockReset();
      cancelMock.mockResolvedValue({} as never);
      createMock.mockImplementation((async () => ({ id: created })) as never);

      const [, res] = await Promise.all([
        activate(activated, activating.clerkId),
        call(createSubscription, creator.clerkId, { plan: "STARTER" }),
      ]);

      const pointer = (await tenantRow(tenant.id)).razorpaySubId;
      if (pointer === activated) {
        restoredByActivation += 1;
        expect(res.status).toBe(409);
        expect(cancelMock).toHaveBeenCalledWith(created, 0);
        expect((await userRow(creator.id)).razorpaySubId).toBeNull();
        expect((await userRow(activating.id)).razorpaySubId).toBe(activated);
      } else {
        recordedByCreate += 1;
        expect(pointer).toBe(created);
        expect(res.status).toBe(200);
        expect((await userRow(creator.id)).razorpaySubId).toBe(created);
        // The activation still applied its own plan/status; it just did not
        // replace the newer pointer or overwrite anyone's id.
        expect((await userRow(activating.id)).razorpaySubId).toBeNull();
      }
      expect((await userRow(activating.id)).subscriptionStatus).toBe("ACTIVE");
    }
    expect(restoredByActivation + recordedByCreate).toBe(6);
  });
});
