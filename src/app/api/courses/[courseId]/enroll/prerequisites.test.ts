import { auth } from "@clerk/nextjs/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { prerequisiteWorld } from "@/lib/domain/course/__test__/prerequisiteFixtures";
import { courseOrderNotes, courseOrderReceipt } from "@/lib/domain/course/paymentVerification";
import { createScenario, createUserIn } from "@/lib/domain/learning-assignment/__test__/fixtures";
import { createManualAssignment } from "@/lib/domain/learning-assignment/assignments";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));
vi.mock("@/lib/razorpay", () => ({
  razorpay: { payments: { fetch: vi.fn() }, orders: { fetch: vi.fn() } },
}));
vi.mock("@/lib/resend", () => ({ resend: { emails: { send: vi.fn().mockResolvedValue({}) } } }));

const { razorpay } = await import("@/lib/razorpay");
const { POST } = await import("./route");

const fetchPayment = vi.mocked(razorpay.payments.fetch) as unknown as ReturnType<typeof vi.fn>;
const fetchOrder = vi.mocked(razorpay.orders.fetch) as unknown as ReturnType<typeof vi.fn>;

type World = Awaited<ReturnType<typeof prerequisiteWorld>>;

const enroll = (slug: string, body?: unknown) =>
  POST(
    new Request("http://localhost/x", {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ courseId: slug }) }
  );

const signInAsLearner = (w: World) =>
  vi.mocked(auth).mockResolvedValue({ userId: w.learner.user.clerkId } as never);

function mockValidPayment(courseId: string, userId: string) {
  fetchPayment.mockResolvedValue({
    id: "pay_1",
    status: "captured",
    amount: 49900,
    currency: "INR",
    order_id: "order_1",
  });
  fetchOrder.mockResolvedValue({
    id: "order_1",
    amount: 49900,
    currency: "INR",
    receipt: courseOrderReceipt(courseId, userId),
    notes: courseOrderNotes(courseId, userId),
  });
}

async function withPrerequisite(w: World) {
  const a = await w.make();
  await w.requires(w.course.id, a.id);
  return a;
}

beforeEach(() => {
  fetchPayment.mockReset();
  fetchOrder.mockReset();
});

afterEach(() => {
  vi.mocked(auth).mockReset();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("POST enroll — prerequisites", () => {
  it("an unmet prerequisite blocks: 409 PREREQUISITES_NOT_MET, the ones that remain, and no enrollment", async () => {
    const w = await prerequisiteWorld();
    const a = await withPrerequisite(w);
    signInAsLearner(w);

    const res = await enroll(w.course.slug);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Complete the prerequisite courses first.",
      code: "PREREQUISITES_NOT_MET",
      prerequisites: [{ courseId: a.id, slug: a.slug, title: a.title }],
    });
    expect(await w.enrollmentCount(w.learner.user.id, w.course.id)).toBe(0);
  });

  it("a completed prerequisite allows enrollment", async () => {
    const w = await prerequisiteWorld();
    const a = await withPrerequisite(w);
    await w.complete(w.learner.user.id, a.id);
    signInAsLearner(w);

    const res = await enroll(w.course.slug);

    expect(res.status).toBe(201);
    expect(await w.enrollmentCount(w.learner.user.id, w.course.id)).toBe(1);
  });

  it("with several prerequisites, all must be completed and only the unmet are named", async () => {
    const w = await prerequisiteWorld();
    const [a, b, c] = await Promise.all([w.make(), w.make(), w.make()]);
    for (const p of [a, b, c]) await w.requires(w.course.id, p.id);
    await w.complete(w.learner.user.id, a.id);
    signInAsLearner(w);

    const blocked = await enroll(w.course.slug);
    expect((await blocked.json()).prerequisites.map((p: { slug: string }) => p.slug)).toEqual([
      b.slug,
      c.slug,
    ]);
    expect(await w.enrollmentCount(w.learner.user.id, w.course.id)).toBe(0);

    await w.complete(w.learner.user.id, b.id);
    await w.complete(w.learner.user.id, c.id);
    expect((await enroll(w.course.slug)).status).toBe(201);
  });

  it("a course with no prerequisites enrolls exactly as before", async () => {
    const w = await prerequisiteWorld();
    signInAsLearner(w);

    expect((await enroll(w.course.slug)).status).toBe(201);
  });

  it.each([
    ["ACTIVE", "ACTIVE"],
    ["REFUNDED", "REFUNDED"],
  ] as const)("a %s enrollment on the prerequisite does not satisfy it", async (_n, status) => {
    const w = await prerequisiteWorld();
    const a = await withPrerequisite(w);
    await w.enroll(w.learner.user.id, a.id, status);
    signInAsLearner(w);

    expect((await enroll(w.course.slug)).status).toBe(409);
  });

  it.each([
    ["archived", (w: World, id: string) => w.archive(id)],
    ["a draft", (w: World, id: string) => w.unpublish(id)],
    ["without a published lesson", (w: World, id: string) => w.removeLessons(id)],
  ])("a prerequisite that is %s is retired and does not block", async (_n, retire) => {
    const w = await prerequisiteWorld();
    const a = await withPrerequisite(w);
    await retire(w, a.id);
    signInAsLearner(w);

    expect((await enroll(w.course.slug)).status).toBe(201);
  });

  it("an enrollment that already exists is grandfathered: a prerequisite added later changes nothing", async () => {
    const w = await prerequisiteWorld();
    await w.enroll(w.learner.user.id, w.course.id, "ACTIVE");
    await withPrerequisite(w);
    signInAsLearner(w);

    const res = await enroll(w.course.slug);

    // The existing answer, not a prerequisite refusal, and the enrollment is untouched.
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Already enrolled" });
    expect(await w.enrollmentCount(w.learner.user.id, w.course.id)).toBe(1);
  });

  it("an existing COMPLETED enrollment stays valid and is not blocked by a newer prerequisite", async () => {
    const w = await prerequisiteWorld();
    await w.complete(w.learner.user.id, w.course.id);
    await withPrerequisite(w);
    signInAsLearner(w);

    expect(await (await enroll(w.course.slug)).json()).toEqual({ error: "Already enrolled" });
    const stored = await db.enrollment.findFirstOrThrow({
      where: { userId: w.learner.user.id, courseId: w.course.id },
    });
    expect(stored.status).toBe("COMPLETED");
  });

  it("a REFUNDED enrollment keeps the existing answer (no new enrollment is created over it)", async () => {
    const w = await prerequisiteWorld();
    await w.enroll(w.learner.user.id, w.course.id, "REFUNDED");
    await withPrerequisite(w);
    signInAsLearner(w);

    const res = await enroll(w.course.slug);

    expect(await res.json()).toEqual({ error: "Already enrolled" });
    expect(await w.enrollmentCount(w.learner.user.id, w.course.id)).toBe(1);
  });

  it("a prerequisite of another tenant cannot influence the result", async () => {
    const w = await prerequisiteWorld();
    const foreign = await prerequisiteWorld();
    await w.requires(w.course.id, foreign.course.id);
    signInAsLearner(w);

    expect((await enroll(w.course.slug)).status).toBe(201);
  });

  it("a learner of another tenant still gets the 404 of before, never a prerequisite answer", async () => {
    const w = await prerequisiteWorld();
    await withPrerequisite(w);
    const outsider = await createScenario();
    vi.mocked(auth).mockResolvedValue({ userId: outsider.learner.user.clerkId } as never);

    const res = await enroll(w.course.slug);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Course not found" });
  });

  it("an unpublished course stays 404, and only students may enroll, whatever the prerequisites", async () => {
    const w = await prerequisiteWorld();
    await withPrerequisite(w);
    await w.unpublish(w.course.id);
    signInAsLearner(w);
    expect((await enroll(w.course.slug)).status).toBe(404);

    await w.make();
    const instructorClerk = w.instructor.user.clerkId;
    await db.course.update({ where: { id: w.course.id }, data: { status: "PUBLISHED" } });
    vi.mocked(auth).mockResolvedValue({ userId: instructorClerk } as never);
    expect((await enroll(w.course.slug)).status).toBe(403);
  });

  it("the refusal names no tenant, and no learner other than the caller", async () => {
    const w = await prerequisiteWorld();
    await withPrerequisite(w);
    const other = await createUserIn(w.tenant.id, "STUDENT");
    signInAsLearner(w);

    const text = JSON.stringify(await (await enroll(w.course.slug)).json());

    expect(text).not.toContain(w.tenant.id);
    expect(text).not.toContain(other.user.id);
    expect(text).not.toContain(w.learner.user.id);
  });
});

describe("POST enroll — paid course: prerequisites are decided before any payment is verified", () => {
  async function paid(w: World) {
    await w.setPrice(w.course.id, 499);
    mockValidPayment(w.course.id, w.learner.user.id);
  }

  it("an unmet prerequisite refuses even a valid captured payment, and never reaches Razorpay", async () => {
    const w = await prerequisiteWorld();
    await withPrerequisite(w);
    await paid(w);
    signInAsLearner(w);

    const res = await enroll(w.course.slug, { razorpayPaymentId: "pay_1" });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("PREREQUISITES_NOT_MET");
    expect(fetchPayment).not.toHaveBeenCalled();
    expect(fetchOrder).not.toHaveBeenCalled();
    expect(await w.enrollmentCount(w.learner.user.id, w.course.id)).toBe(0);
  });

  it("a completed prerequisite lets the paid enrollment proceed through payment verification", async () => {
    const w = await prerequisiteWorld();
    const a = await withPrerequisite(w);
    await w.complete(w.learner.user.id, a.id);
    await paid(w);
    signInAsLearner(w);

    const res = await enroll(w.course.slug, { razorpayPaymentId: "pay_1" });

    expect(res.status).toBe(201);
    expect(fetchOrder).toHaveBeenCalledWith("order_1");
  });
});

describe("POST enroll — concurrency", () => {
  it("ten simultaneous attempts with an unmet prerequisite are all refused, none throws, and no enrollment appears", async () => {
    const w = await prerequisiteWorld();
    await withPrerequisite(w);
    signInAsLearner(w);

    const responses = await Promise.all(Array.from({ length: 10 }, () => enroll(w.course.slug)));

    expect(responses.map((r) => r.status)).toEqual(Array(10).fill(409));
    for (const r of responses) expect((await r.json()).code).toBe("PREREQUISITES_NOT_MET");
    expect(await w.enrollmentCount(w.learner.user.id, w.course.id)).toBe(0);
  });

  it("completion committed before the check: enrollment succeeds; after it: refused, then succeeds once completed", async () => {
    const w = await prerequisiteWorld();
    const a = await withPrerequisite(w);
    await w.enroll(w.learner.user.id, a.id, "ACTIVE");
    signInAsLearner(w);

    expect((await enroll(w.course.slug)).status).toBe(409);
    await w.completeExisting(w.learner.user.id, a.id);
    expect((await enroll(w.course.slug)).status).toBe(201);
  });

  it("a real race between completing the prerequisite and enrolling always ends in one of the two valid states", async () => {
    const outcomes: number[] = [];
    for (let i = 0; i < 8; i++) {
      const w = await prerequisiteWorld();
      const a = await withPrerequisite(w);
      await w.enroll(w.learner.user.id, a.id, "ACTIVE");
      signInAsLearner(w);

      const [, res] = await Promise.all([
        w.completeExisting(w.learner.user.id, a.id),
        enroll(w.course.slug),
      ]);

      const enrollments = await w.enrollmentCount(w.learner.user.id, w.course.id);
      // Either it saw the incomplete prerequisite (refused, nothing created) or the
      // committed completion (enrolled once). Never both, never a half-created row.
      expect([201, 409]).toContain(res.status);
      expect(enrollments).toBe(res.status === 201 ? 1 : 0);
      const prerequisite = await db.enrollment.findFirstOrThrow({
        where: { userId: w.learner.user.id, courseId: a.id },
      });
      expect(prerequisite.status).toBe("COMPLETED");
      outcomes.push(res.status);
    }
    expect(outcomes).toHaveLength(8);
  });

  it("an assignment racing an enrollment cannot get the learner in past an unmet prerequisite", async () => {
    const w = await prerequisiteWorld();
    await withPrerequisite(w);
    signInAsLearner(w);

    const [res, assigned] = await Promise.all([
      enroll(w.course.slug),
      createManualAssignment(w.admin.ctx, { userId: w.learner.user.id, courseId: w.course.id }),
    ]);

    expect(res.status).toBe(409);
    expect(assigned).toMatchObject({ ok: false, reason: "PREREQUISITES_NOT_MET" });
    expect(await w.enrollmentCount(w.learner.user.id, w.course.id)).toBe(0);
    expect(await db.learningAssignment.count({ where: { userId: w.learner.user.id } })).toBe(0);
  });

  it("with the prerequisite met, an assignment racing an enrollment still yields exactly one enrollment", async () => {
    const w = await prerequisiteWorld();
    const a = await withPrerequisite(w);
    await w.complete(w.learner.user.id, a.id);
    signInAsLearner(w);

    const [res, assigned] = await Promise.all([
      enroll(w.course.slug),
      createManualAssignment(w.admin.ctx, { userId: w.learner.user.id, courseId: w.course.id }),
    ]);

    expect([201, 409]).toContain(res.status);
    expect(assigned.ok).toBe(true);
    expect(await w.enrollmentCount(w.learner.user.id, w.course.id)).toBe(1);
    expect(await db.learningAssignment.count({ where: { userId: w.learner.user.id } })).toBe(1);
  });
});
