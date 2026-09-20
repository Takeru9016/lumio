import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubscriptionStatus } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { createSoloUser, createUserInTenant } from "@/lib/domain/course/__test__/fixtures";
import { createTenantUser } from "@/lib/domain/knowledge/__test__/fixtures";

/**
 * GET /api/cron/downgrade-subscriptions against the REAL database. A due
 * cancellation is only a candidate: the tenant is downgraded only when nobody
 * holding the tenant's CURRENT subscription id is in a live state.
 */
vi.mock("@/lib/resend", () => ({ resend: { emails: { send: vi.fn().mockResolvedValue({}) } } }));

const { GET: runCron } = await import("./route");
const { POST: razorpayWebhook } = await import("@/app/api/webhooks/razorpay/route");

const ENV_KEYS = ["CRON_SECRET", "RAZORPAY_WEBHOOK_SECRET"] as const;
const savedEnv: Record<string, string | undefined> = {};
let counter = 0;

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.CRON_SECRET = "cron-secret-test";
  process.env.RAZORPAY_WEBHOOK_SECRET = "webhook-secret-test";
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

afterAll(async () => {
  await db.$disconnect();
});

const dueAt = () => new Date(Date.now() - 60_000);
const laterAt = () => new Date(Date.now() + 86_400_000);
const subId = (label: string) => `sub_${label}_${Date.now()}_${++counter}`;

function cronRequest(authorization: string | null = "Bearer cron-secret-test") {
  return new NextRequest("http://localhost/api/cron/downgrade-subscriptions", {
    headers: authorization ? { authorization } : {},
  });
}

async function runAndExpectOk() {
  const res = await runCron(cronRequest());
  expect(res.status).toBe(200);
  return res.json() as Promise<{ downgraded: number }>;
}

/** A paid tenant whose current subscription id is `pointer`. */
async function paidOrg(pointer: string | null, plan: "STARTER" | "PRO" = "STARTER") {
  const { tenant, user: admin } = await createTenantUser("ORG_ADMIN");
  await db.tenant.update({
    where: { id: tenant.id },
    data: { plan, seatLimit: plan === "PRO" ? 100 : 10, razorpaySubId: pointer },
  });
  await db.user.update({ where: { id: admin.id }, data: { plan } });
  return { tenant, admin };
}

async function setBilling(
  userId: string,
  data: {
    razorpaySubId?: string | null;
    subscriptionStatus?: SubscriptionStatus | null;
    scheduledDowngradeAt?: Date | null;
    cancelAtPeriodEnd?: boolean;
    plan?: "FREE" | "STARTER" | "PRO";
  }
) {
  await db.user.update({ where: { id: userId }, data });
}

/**
 * Tenant whose current subscription is `newSub`, owned by a second admin in
 * `status`; a superseded owner of `oldSub` still holds a due cancellation.
 */
async function supersededOrg(status: SubscriptionStatus | null) {
  const oldSub = subId("old");
  const newSub = subId("new");
  const { tenant, admin: oldOwner } = await paidOrg(newSub);
  await setBilling(oldOwner.id, {
    razorpaySubId: oldSub,
    subscriptionStatus: "CANCELLED",
    scheduledDowngradeAt: dueAt(),
  });
  const newOwner = await createUserInTenant(tenant.id, "ORG_ADMIN");
  await setBilling(newOwner.id, {
    razorpaySubId: newSub,
    subscriptionStatus: status,
    plan: "STARTER",
  });
  return { tenant, oldOwner, oldSub, newSub, newOwner };
}

const tenantRow = (id: string) => db.tenant.findUniqueOrThrow({ where: { id } });
const userRow = (id: string) => db.user.findUniqueOrThrow({ where: { id } });

async function expectTenantKept(tenantId: string, pointer: string, plan = "STARTER", seats = 10) {
  const tenant = await tenantRow(tenantId);
  expect(tenant.plan).toBe(plan);
  expect(tenant.seatLimit).toBe(seats);
  expect(tenant.razorpaySubId).toBe(pointer);
}

async function expectTenantDowngraded(tenantId: string) {
  const tenant = await tenantRow(tenantId);
  expect(tenant.plan).toBe("FREE");
  expect(tenant.seatLimit).toBe(3);
  expect(tenant.razorpaySubId).toBeNull();
  const members = await db.user.findMany({ where: { tenantId } });
  expect(members.length).toBeGreaterThan(0);
  for (const member of members) expect(member.plan).toBe("FREE");
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

const inThePast = () => Math.floor(Date.now() / 1000) - 3600;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type HolderArgs = { where?: { tenantId?: string } };
type Tx = {
  tenant: { findUnique: (...args: unknown[]) => Promise<unknown> };
  user: { findMany: (...args: unknown[]) => Promise<unknown> };
};

/**
 * Barriers inside the cron's per-cancellation transaction, at each point where a
 * concurrent request can make the cron's view stale: `before` it starts,
 * `afterTenantRead` once it has the tenant's current subscription id, and
 * `afterHolderRead` once it has the liveness snapshot of that subscription's
 * holders — the last point before the downgrade decision, and the one the
 * tenant row lock has to already cover. `afterHolderRead` receives the holder
 * query's arguments so a test can act only on its own tenant.
 */
function interleave(hooks: {
  before?: () => Promise<void>;
  afterTenantRead?: () => Promise<void>;
  afterHolderRead?: (args: HolderArgs) => Promise<void>;
}) {
  const real = db.$transaction.bind(db) as unknown as (
    fn: (tx: Tx) => Promise<unknown>,
    options?: unknown
  ) => Promise<unknown>;
  return vi.spyOn(db, "$transaction").mockImplementation(((
    fn: (tx: Tx) => Promise<unknown>,
    options?: unknown
  ) => {
    const run = async () => {
      await hooks.before?.();
      return real((tx) => {
        const wrapped = new Proxy(tx, {
          get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (prop === "tenant") {
              return new Proxy(value as Tx["tenant"], {
                get(tenantTarget, tenantProp, tenantReceiver) {
                  if (tenantProp !== "findUnique") {
                    return Reflect.get(tenantTarget, tenantProp, tenantReceiver);
                  }
                  return async (...args: unknown[]) => {
                    const result = await tenantTarget.findUnique(...args);
                    await hooks.afterTenantRead?.();
                    return result;
                  };
                },
              });
            }
            if (prop === "user") {
              return new Proxy(value as Tx["user"], {
                get(userTarget, userProp, userReceiver) {
                  if (userProp !== "findMany") {
                    return Reflect.get(userTarget, userProp, userReceiver);
                  }
                  return async (...args: unknown[]) => {
                    const result = await userTarget.findMany(...args);
                    await hooks.afterHolderRead?.((args[0] ?? {}) as HolderArgs);
                    return result;
                  };
                },
              });
            }
            return value;
          },
        });
        return fn(wrapped);
      }, options);
    };
    return run();
  }) as never);
}

describe("GET /api/cron/downgrade-subscriptions — authorization", () => {
  it("401s without the bearer secret and changes nothing", async () => {
    const oldSub = subId("auth");
    const { tenant, admin } = await paidOrg(oldSub);
    await setBilling(admin.id, {
      razorpaySubId: oldSub,
      subscriptionStatus: "CANCELLED",
      scheduledDowngradeAt: dueAt(),
    });

    for (const header of [null, "Bearer wrong"]) {
      const res = await runCron(cronRequest(header));
      expect(res.status).toBe(401);
    }

    await expectTenantKept(tenant.id, oldSub);
    expect((await userRow(admin.id)).subscriptionStatus).toBe("CANCELLED");
  });

  it("401s when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET;
    const res = await runCron(cronRequest("Bearer undefined"));
    expect(res.status).toBe(401);
  });
});

describe("Case C — no replacement: the tenant still points at the cancelled subscription", () => {
  it("downgrades the tenant and the owner exactly as before", async () => {
    const oldSub = subId("only");
    const { tenant, admin } = await paidOrg(oldSub, "PRO");
    const member = await createUserInTenant(tenant.id, "STUDENT");
    await setBilling(member.id, { plan: "PRO" });
    await setBilling(admin.id, {
      razorpaySubId: oldSub,
      subscriptionStatus: "CANCELLED",
      scheduledDowngradeAt: dueAt(),
      cancelAtPeriodEnd: true,
    });

    const { downgraded } = await runAndExpectOk();

    expect(downgraded).toBeGreaterThanOrEqual(1);
    await expectTenantDowngraded(tenant.id);
    const owner = await userRow(admin.id);
    expect(owner.plan).toBe("FREE");
    expect(owner.subscriptionStatus).toBeNull();
    expect(owner.cancelAtPeriodEnd).toBe(false);
    expect(owner.scheduledDowngradeAt).toBeNull();
    expect(owner.razorpaySubId).toBeNull();
    expect((await userRow(member.id)).plan).toBe("FREE");
  });

  it("is idempotent: a second run changes nothing further", async () => {
    const oldSub = subId("idem");
    const { tenant, admin } = await paidOrg(oldSub);
    await setBilling(admin.id, {
      razorpaySubId: oldSub,
      subscriptionStatus: "CANCELLED",
      scheduledDowngradeAt: dueAt(),
    });

    await runAndExpectOk();
    const first = await tenantRow(tenant.id);
    await runAndExpectOk();

    expect(await tenantRow(tenant.id)).toEqual(first);
    await expectTenantDowngraded(tenant.id);
  });

  it("leaves a cancellation that is not yet due, and non-cancelled owners, alone", async () => {
    const futureSub = subId("future");
    const { tenant: futureTenant, admin: futureAdmin } = await paidOrg(futureSub);
    await setBilling(futureAdmin.id, {
      razorpaySubId: futureSub,
      subscriptionStatus: "CANCELLED",
      scheduledDowngradeAt: laterAt(),
    });
    const activeSub = subId("active");
    const { tenant: activeTenant, admin: activeAdmin } = await paidOrg(activeSub);
    await setBilling(activeAdmin.id, {
      razorpaySubId: activeSub,
      subscriptionStatus: "ACTIVE",
      scheduledDowngradeAt: dueAt(),
    });

    await runAndExpectOk();

    await expectTenantKept(futureTenant.id, futureSub);
    await expectTenantKept(activeTenant.id, activeSub);
  });

  it("downgrades a tenant whose pointer is already null (existing behavior preserved)", async () => {
    const { tenant, admin } = await paidOrg(null);
    await setBilling(admin.id, {
      razorpaySubId: subId("orphan"),
      subscriptionStatus: "CANCELLED",
      scheduledDowngradeAt: dueAt(),
    });

    await runAndExpectOk();

    await expectTenantDowngraded(tenant.id);
  });

  it("a live-looking member with no subscription id does not shield a tenant that has no current subscription", async () => {
    const { tenant, admin } = await paidOrg(null);
    await setBilling(admin.id, {
      razorpaySubId: subId("orphan"),
      subscriptionStatus: "CANCELLED",
      scheduledDowngradeAt: dueAt(),
    });
    const bystander = await createUserInTenant(tenant.id, "STUDENT");
    await setBilling(bystander.id, { razorpaySubId: null, subscriptionStatus: "ACTIVE" });

    await runAndExpectOk();

    await expectTenantDowngraded(tenant.id);
  });

  it("downgrades only the user when the cancelled user has no tenant", async () => {
    const solo = await createSoloUser("STUDENT");
    await setBilling(solo.id, {
      plan: "STARTER",
      razorpaySubId: subId("solo"),
      subscriptionStatus: "CANCELLED",
      scheduledDowngradeAt: dueAt(),
    });

    await runAndExpectOk();

    const row = await userRow(solo.id);
    expect(row.plan).toBe("FREE");
    expect(row.subscriptionStatus).toBeNull();
    expect(row.razorpaySubId).toBeNull();
  });
});

describe("Case A — the replacement is live: a stale cancellation must not touch the tenant", () => {
  it.each(["ACTIVE", "PAST_DUE", "PAUSED"] as const)(
    "keeps the tenant and the new subscription when the replacement is %s (different admin)",
    async (status) => {
      const { tenant, oldOwner, oldSub, newSub, newOwner } = await supersededOrg(status);

      await runAndExpectOk();

      await expectTenantKept(tenant.id, newSub);
      const owner = await userRow(newOwner.id);
      expect(owner.subscriptionStatus).toBe(status);
      expect(owner.razorpaySubId).toBe(newSub);
      expect(owner.plan).toBe("STARTER");
      // The stale record is retired, not applied: only its due date is cleared.
      const old = await userRow(oldOwner.id);
      expect(old.scheduledDowngradeAt).toBeNull();
      expect(old.subscriptionStatus).toBe("CANCELLED");
      expect(old.razorpaySubId).toBe(oldSub);
      expect(old.plan).toBe("STARTER");
    }
  );

  it("keeps an ACTIVE same-admin replacement: the owner is no longer a cancellation candidate", async () => {
    const newSub = subId("same");
    const { tenant, admin } = await paidOrg(newSub);
    await setBilling(admin.id, {
      razorpaySubId: newSub,
      subscriptionStatus: "ACTIVE",
      scheduledDowngradeAt: dueAt(),
    });

    await runAndExpectOk();

    await expectTenantKept(tenant.id, newSub);
    expect((await userRow(admin.id)).subscriptionStatus).toBe("ACTIVE");
  });

  it("does not re-read a retired stale cancellation on the next run", async () => {
    const { tenant, oldOwner, newSub } = await supersededOrg("ACTIVE");

    await runAndExpectOk();
    expect((await userRow(oldOwner.id)).scheduledDowngradeAt).toBeNull();
    await runAndExpectOk();

    await expectTenantKept(tenant.id, newSub);
  });
});

describe("Case B — the replacement never became live (N1): paid entitlement must not persist", () => {
  it("downgrades when the replacement was created but never activated (different admin)", async () => {
    const { tenant, oldOwner, newSub, newOwner } = await supersededOrg(null);

    await runAndExpectOk();

    await expectTenantDowngraded(tenant.id);
    const old = await userRow(oldOwner.id);
    expect(old.subscriptionStatus).toBeNull();
    expect(old.scheduledDowngradeAt).toBeNull();
    expect(old.razorpaySubId).toBeNull();
    expect(old.plan).toBe("FREE");
    // The abandoned subscription's owner keeps its never-activated record.
    const abandoned = await userRow(newOwner.id);
    expect(abandoned.subscriptionStatus).toBeNull();
    expect(abandoned.razorpaySubId).toBe(newSub);
  });

  it("downgrades when the tenant's current subscription id has no owner at all", async () => {
    const oldSub = subId("none-old");
    const { tenant, admin: oldOwner } = await paidOrg(subId("none-new"));
    await setBilling(oldOwner.id, {
      razorpaySubId: oldSub,
      subscriptionStatus: "CANCELLED",
      scheduledDowngradeAt: dueAt(),
    });

    await runAndExpectOk();

    await expectTenantDowngraded(tenant.id);
  });

  it("downgrades when the replacement owner is the same admin and it never activated", async () => {
    const newSub = subId("abandoned-same");
    const { tenant, admin } = await paidOrg(newSub);
    // The admin's own cancelled record, now carrying the never-activated new id.
    await setBilling(admin.id, {
      razorpaySubId: newSub,
      subscriptionStatus: "CANCELLED",
      scheduledDowngradeAt: dueAt(),
    });

    await runAndExpectOk();

    await expectTenantDowngraded(tenant.id);
    const row = await userRow(admin.id);
    expect(row.subscriptionStatus).toBeNull();
    expect(row.razorpaySubId).toBeNull();
  });

  it("stays downgraded on later runs", async () => {
    const { tenant } = await supersededOrg(null);

    await runAndExpectOk();
    await runAndExpectOk();

    await expectTenantDowngraded(tenant.id);
  });
});

describe("Case D — a stale or replayed cancellation webhook re-arms the superseded owner (F3)", () => {
  it("does not downgrade a live replacement (different admin)", async () => {
    const { tenant, oldOwner, oldSub, newSub } = await supersededOrg("ACTIVE");
    // The old owner was already retired once; a late/replayed webhook re-arms it.
    await setBilling(oldOwner.id, { scheduledDowngradeAt: null, subscriptionStatus: null });

    await sendWebhook("subscription.cancelled", {
      id: oldSub,
      current_end: inThePast(),
      notes: { userId: oldOwner.clerkId, plan: "STARTER" },
    });
    const rearmed = await userRow(oldOwner.id);
    expect(rearmed.subscriptionStatus).toBe("CANCELLED");
    expect(rearmed.scheduledDowngradeAt).not.toBeNull();

    await runAndExpectOk();

    await expectTenantKept(tenant.id, newSub);
  });

  it("does not downgrade a live PAST_DUE or PAUSED replacement either", async () => {
    for (const status of ["PAST_DUE", "PAUSED"] as const) {
      const { tenant, oldOwner, oldSub, newSub } = await supersededOrg(status);
      await setBilling(oldOwner.id, { scheduledDowngradeAt: null, subscriptionStatus: null });
      await sendWebhook("subscription.cancelled", {
        id: oldSub,
        current_end: inThePast(),
        notes: { userId: oldOwner.clerkId, plan: "STARTER" },
      });

      await runAndExpectOk();

      await expectTenantKept(tenant.id, newSub);
    }
  });

  it("still does not leave a non-live replacement paid forever", async () => {
    const { tenant, oldOwner, oldSub } = await supersededOrg(null);
    await sendWebhook("subscription.cancelled", {
      id: oldSub,
      current_end: inThePast(),
      notes: { userId: oldOwner.clerkId, plan: "STARTER" },
    });

    await runAndExpectOk();

    await expectTenantDowngraded(tenant.id);
  });

  it("a real cancellation of the CURRENT subscription (delivered by the webhook) still downgrades", async () => {
    const sub = subId("real");
    const { tenant, admin } = await paidOrg(sub);
    await setBilling(admin.id, { razorpaySubId: sub, subscriptionStatus: "ACTIVE" });

    await sendWebhook("subscription.cancelled", {
      id: sub,
      current_end: inThePast(),
      notes: { userId: admin.clerkId, plan: "STARTER" },
    });
    await runAndExpectOk();

    await expectTenantDowngraded(tenant.id);
  });
});

describe("tenant isolation", () => {
  it("a stale cancellation in one tenant never shields or harms another tenant", async () => {
    const staleLive = await supersededOrg("ACTIVE");
    const plain = subId("plain");
    const { tenant: otherTenant, admin: otherAdmin } = await paidOrg(plain);
    await setBilling(otherAdmin.id, {
      razorpaySubId: plain,
      subscriptionStatus: "CANCELLED",
      scheduledDowngradeAt: dueAt(),
    });

    await runAndExpectOk();

    await expectTenantKept(staleLive.tenant.id, staleLive.newSub);
    await expectTenantDowngraded(otherTenant.id);
  });

  it("a live subscription in another tenant cannot make this tenant look live", async () => {
    const oldSub = subId("iso-old");
    const newSub = subId("iso-new");
    const { tenant, admin: oldOwner } = await paidOrg(newSub);
    await setBilling(oldOwner.id, {
      razorpaySubId: oldSub,
      subscriptionStatus: "CANCELLED",
      scheduledDowngradeAt: dueAt(),
    });
    // Someone in ANOTHER tenant holds the same id and is ACTIVE.
    const { admin: foreign } = await paidOrg(null);
    await setBilling(foreign.id, { razorpaySubId: newSub, subscriptionStatus: "ACTIVE" });

    await runAndExpectOk();

    await expectTenantDowngraded(tenant.id);
    const foreignRow = await userRow(foreign.id);
    expect(foreignRow.subscriptionStatus).toBe("ACTIVE");
    expect(foreignRow.razorpaySubId).toBe(newSub);
    expect(foreignRow.plan).toBe("STARTER");
  });
});

describe("duplicate local subscription ids (no unique constraint on User.razorpaySubId)", () => {
  it.each([
    ["live row created first", ["ACTIVE", "CANCELLED"]],
    ["stale row created first", ["CANCELLED", "ACTIVE"]],
  ] as const)(
    "judges the tenant by every holder of its current id, not one arbitrary row (%s)",
    async (_label, order) => {
      const pointer = subId("dup");
      const { tenant, admin } = await paidOrg(pointer);
      await db.user.delete({ where: { id: admin.id } });
      const rows: string[] = [];
      for (const status of order) {
        const holder = await createUserInTenant(tenant.id, "ORG_ADMIN");
        await setBilling(holder.id, {
          razorpaySubId: pointer,
          subscriptionStatus: status,
          scheduledDowngradeAt: status === "CANCELLED" ? dueAt() : null,
          plan: "STARTER",
        });
        rows.push(holder.id);
      }

      await runAndExpectOk();

      await expectTenantKept(tenant.id, pointer);
      const live = await db.user.findMany({
        where: { id: { in: rows }, subscriptionStatus: "ACTIVE" },
      });
      expect(live).toHaveLength(1);
    }
  );

  it("downgrades when every holder of the current id is cancelled", async () => {
    const pointer = subId("dup-dead");
    const { tenant, admin } = await paidOrg(pointer);
    const second = await createUserInTenant(tenant.id, "ORG_ADMIN");
    for (const id of [admin.id, second.id]) {
      await setBilling(id, {
        razorpaySubId: pointer,
        subscriptionStatus: "CANCELLED",
        scheduledDowngradeAt: dueAt(),
      });
    }

    await runAndExpectOk();

    await expectTenantDowngraded(tenant.id);
  });
});

describe("concurrent runs", () => {
  it("two runs executing at the same time downgrade a tenant exactly once", async () => {
    await runAndExpectOk();
    const oldSub = subId("concurrent");
    const { tenant, admin } = await paidOrg(oldSub);
    const member = await createUserInTenant(tenant.id, "STUDENT");
    await setBilling(member.id, { plan: "STARTER" });
    await setBilling(admin.id, {
      razorpaySubId: oldSub,
      subscriptionStatus: "CANCELLED",
      scheduledDowngradeAt: dueAt(),
    });

    const [first, second] = await Promise.all([runAndExpectOk(), runAndExpectOk()]);

    expect([first.downgraded, second.downgraded].sort()).toEqual([0, 1]);
    await expectTenantDowngraded(tenant.id);
    const owner = await userRow(admin.id);
    expect(owner.subscriptionStatus).toBeNull();
    expect(owner.razorpaySubId).toBeNull();
  });
});

describe("a replacement activating while the cron runs (R-1)", () => {
  const inTheFuture = () => Math.floor(Date.now() / 1000) + 30 * 86_400;

  /**
   * The state create-subscription leaves behind: the tenant points at the
   * replacement, which has not activated yet, while the superseded owner still
   * carries the due cancellation. Same-admin means the cancelled owner is also
   * the one who created the replacement, so a single row carries both.
   */
  async function pendingReplacement(sameAdmin: boolean) {
    const oldSub = subId("r1-old");
    const newSub = subId("r1-new");
    const { tenant, admin: oldOwner } = await paidOrg(newSub);
    await setBilling(oldOwner.id, {
      razorpaySubId: sameAdmin ? newSub : oldSub,
      subscriptionStatus: "CANCELLED",
      scheduledDowngradeAt: dueAt(),
    });
    let creator = oldOwner;
    if (!sameAdmin) {
      creator = await createUserInTenant(tenant.id, "ORG_ADMIN");
      await setBilling(creator.id, {
        razorpaySubId: newSub,
        subscriptionStatus: null,
        plan: "STARTER",
      });
    }
    return { tenant, oldOwner, creator, oldSub, newSub };
  }

  function activateReplacement(newSub: string, clerkId: string) {
    return sendWebhook("subscription.activated", {
      id: newSub,
      current_end: inTheFuture(),
      notes: { userId: clerkId, plan: "STARTER" },
    });
  }

  /** Whichever transaction wins the tenant lock, this is the only coherent end state. */
  async function expectCoherentlyActive(tenantId: string, creatorId: string, newSub: string) {
    const tenant = await tenantRow(tenantId);
    expect(tenant.plan).toBe("STARTER");
    expect(tenant.seatLimit).toBe(10);
    expect(tenant.razorpaySubId).toBe(newSub);
    const creator = await userRow(creatorId);
    expect(creator.subscriptionStatus).toBe("ACTIVE");
    expect(creator.razorpaySubId).toBe(newSub);
    expect(creator.plan).toBe("STARTER");
    expect(creator.currentPeriodEnd).not.toBeNull();
    // Mirrors the cron's own candidate predicate: this row is not selectable.
    const selectable = await db.user.findFirst({
      where: {
        id: creatorId,
        subscriptionStatus: "CANCELLED",
        scheduledDowngradeAt: { lte: new Date() },
      },
      select: { id: true },
    });
    expect(selectable).toBeNull();
  }

  it.each([
    ["same admin", true],
    ["different admin", false],
  ] as const)(
    "%s: an activation arriving after the holder read blocks on the tenant lock, and the subscription survives",
    async (_label, sameAdmin) => {
      const { tenant, creator, newSub, oldOwner } = await pendingReplacement(sameAdmin);
      let activation: Promise<void> | undefined;
      let settled = false;
      let settledInsideTheWindow: boolean | null = null;

      interleave({
        afterHolderRead: async (args) => {
          if (args.where?.tenantId !== tenant.id || activation) return;
          activation = activateReplacement(newSub, creator.clerkId).then(() => {
            settled = true;
          });
          // The cron holds the tenant row lock from before its own holder read,
          // so the activation cannot commit inside this window.
          await sleep(300);
          settledInsideTheWindow = settled;
        },
      });

      await runAndExpectOk();
      await activation;

      expect(settledInsideTheWindow).toBe(false);
      await expectCoherentlyActive(tenant.id, creator.id, newSub);
      if (!sameAdmin) {
        // The superseded owner was downgraded by the cron and carries no
        // cancellation the next run could act on.
        const old = await userRow(oldOwner.id);
        expect(old.subscriptionStatus).toBeNull();
        expect(old.scheduledDowngradeAt).toBeNull();
        expect(old.razorpaySubId).toBeNull();
      }
      await runAndExpectOk();
      await expectCoherentlyActive(tenant.id, creator.id, newSub);
    }
  );

  it.each([
    ["same admin", true],
    ["different admin", false],
  ] as const)(
    "%s: an activation that commits first is seen as live, so the cron preserves the tenant",
    async (_label, sameAdmin) => {
      const { tenant, creator, newSub, oldOwner } = await pendingReplacement(sameAdmin);
      let fired = false;

      interleave({
        before: async () => {
          if (fired) return;
          fired = true;
          await activateReplacement(newSub, creator.clerkId);
        },
      });

      const { downgraded } = await runAndExpectOk();

      expect(downgraded).toBe(0);
      await expectCoherentlyActive(tenant.id, creator.id, newSub);
      if (!sameAdmin) {
        // The stale cancellation is retired rather than applied.
        const old = await userRow(oldOwner.id);
        expect(old.subscriptionStatus).toBe("CANCELLED");
        expect(old.scheduledDowngradeAt).toBeNull();
      }
    }
  );

  it.each([
    ["same admin", true],
    ["different admin", false],
  ] as const)(
    "%s: cron and activation started together converge on the same state, with no deadlock",
    async (_label, sameAdmin) => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const { tenant, creator, newSub } = await pendingReplacement(sameAdmin);

        const [cronResult, activationResult] = await Promise.allSettled([
          runCron(cronRequest()),
          activateReplacement(newSub, creator.clerkId),
        ]);

        // A Tenant->User ordering in one transaction and User->Tenant in the
        // other would surface here as a deadlock rejection.
        expect(cronResult.status).toBe("fulfilled");
        expect(activationResult.status).toBe("fulfilled");
        if (cronResult.status === "fulfilled") expect(cronResult.value.status).toBe(200);
        await expectCoherentlyActive(tenant.id, creator.id, newSub);
      }
    }
  );
});

describe("races with create-subscription", () => {
  it("makes a replacement recorded mid-cron wait for the tenant lock instead of landing on a stale view", async () => {
    const { tenant, oldOwner, oldSub, newSub } = await supersededOrg("ACTIVE");
    // Put the tenant back on the cancelled subscription; the replacement lands mid-cron.
    await db.tenant.update({ where: { id: tenant.id }, data: { razorpaySubId: oldSub } });
    let replacement: Promise<{ count: number }> | undefined;
    let settled = false;
    let settledInsideTheWindow: boolean | null = null;

    interleave({
      afterTenantRead: async () => {
        if (replacement) return;
        // The same compare-and-set create-subscription performs, from another connection.
        replacement = db.tenant
          .updateMany({
            where: { id: tenant.id, razorpaySubId: oldSub },
            data: { razorpaySubId: newSub },
          })
          .then((result) => {
            settled = true;
            return result;
          });
        await sleep(300);
        settledInsideTheWindow = settled;
      },
    });

    await runAndExpectOk();
    const result = await replacement;

    // The tenant row lock is held from before the cron's reads, so a concurrent
    // replacement cannot be recorded against the view the cron already took.
    expect(settledInsideTheWindow).toBe(false);
    // It commits after the downgrade, where its own compare-and-set matches
    // nothing — create-subscription answers 409 and cancels the orphan.
    expect(result?.count).toBe(0);
    await expectTenantDowngraded(tenant.id);
    expect((await userRow(oldOwner.id)).subscriptionStatus).toBeNull();
  });

  it("re-reads the cancellation inside the transaction and skips one that was reversed meanwhile", async () => {
    const oldSub = subId("reversed");
    const { tenant, admin } = await paidOrg(oldSub);
    await setBilling(admin.id, {
      razorpaySubId: oldSub,
      subscriptionStatus: "CANCELLED",
      scheduledDowngradeAt: dueAt(),
    });
    interleave({
      before: async () => {
        await setBilling(admin.id, { subscriptionStatus: "ACTIVE", scheduledDowngradeAt: null });
      },
    });

    await runAndExpectOk();

    await expectTenantKept(tenant.id, oldSub);
    expect((await userRow(admin.id)).subscriptionStatus).toBe("ACTIVE");
  });

  it("skips a cancellation an overlapping run already processed, so it cannot downgrade a pending replacement", async () => {
    const oldSub = subId("overlap-old");
    const pendingSub = subId("overlap-new");
    const { tenant, admin } = await paidOrg(oldSub);
    await setBilling(admin.id, {
      razorpaySubId: oldSub,
      subscriptionStatus: "CANCELLED",
      scheduledDowngradeAt: dueAt(),
    });
    interleave({
      before: async () => {
        // The other run already retired this cancellation; a replacement was then recorded.
        await setBilling(admin.id, { subscriptionStatus: null, scheduledDowngradeAt: null });
        await db.tenant.update({ where: { id: tenant.id }, data: { razorpaySubId: pendingSub } });
      },
    });

    await runAndExpectOk();

    await expectTenantKept(tenant.id, pendingSub);
  });
});
