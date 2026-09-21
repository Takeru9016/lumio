import { auth } from "@clerk/nextjs/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { prerequisiteWorld } from "@/lib/domain/course/__test__/prerequisiteFixtures";
import { courseOrderNotes, courseOrderReceipt } from "@/lib/domain/course/paymentVerification";
import { createScenario } from "@/lib/domain/learning-assignment/__test__/fixtures";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));
vi.mock("@/lib/razorpay", () => ({ razorpay: { orders: { create: vi.fn() } } }));

const { razorpay } = await import("@/lib/razorpay");
const { POST } = await import("./route");

const createOrder = vi.mocked(razorpay.orders.create) as unknown as ReturnType<typeof vi.fn>;

type World = Awaited<ReturnType<typeof prerequisiteWorld>>;

const order = (slug: string) =>
  POST(new Request("http://localhost/x", { method: "POST" }) as never, {
    params: Promise.resolve({ courseId: slug }),
  });

async function paidWorld() {
  const w = await prerequisiteWorld();
  await w.setPrice(w.course.id, 499);
  vi.mocked(auth).mockResolvedValue({ userId: w.learner.user.clerkId } as never);
  return w;
}

async function withPrerequisite(w: World) {
  const a = await w.make();
  await w.requires(w.course.id, a.id);
  return a;
}

beforeEach(() => {
  createOrder.mockReset();
  createOrder.mockResolvedValue({ id: "order_1", amount: 49900, currency: "INR" });
});

afterEach(() => {
  vi.mocked(auth).mockReset();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("POST order — prerequisites are decided before Razorpay is called", () => {
  it("an unmet prerequisite is refused with PREREQUISITES_NOT_MET and creates NO payment order", async () => {
    const w = await paidWorld();
    const a = await withPrerequisite(w);

    const res = await order(w.course.slug);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Complete the prerequisite courses first.",
      code: "PREREQUISITES_NOT_MET",
      prerequisites: [{ courseId: a.id, slug: a.slug, title: a.title }],
    });
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("a completed prerequisite lets the order be created, with the receipt the enroll route verifies", async () => {
    const w = await paidWorld();
    const a = await withPrerequisite(w);
    await w.complete(w.learner.user.id, a.id);

    const res = await order(w.course.slug);

    expect(res.status).toBe(200);
    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(createOrder).toHaveBeenCalledWith({
      amount: 49900,
      currency: "INR",
      receipt: courseOrderReceipt(w.course.id, w.learner.user.id),
      notes: courseOrderNotes(w.course.id, w.learner.user.id),
    });
  });

  it("with several prerequisites all must be completed before an order exists", async () => {
    const w = await paidWorld();
    const [a, b] = await Promise.all([w.make(), w.make()]);
    await w.requires(w.course.id, a.id);
    await w.requires(w.course.id, b.id);
    await w.complete(w.learner.user.id, a.id);

    expect((await order(w.course.slug)).status).toBe(409);
    expect(createOrder).not.toHaveBeenCalled();

    await w.complete(w.learner.user.id, b.id);
    expect((await order(w.course.slug)).status).toBe(200);
    expect(createOrder).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["archived", (w: World, id: string) => w.archive(id)],
    ["a draft", (w: World, id: string) => w.unpublish(id)],
    ["without a published lesson", (w: World, id: string) => w.removeLessons(id)],
  ])("a retired prerequisite (%s) does not stop the order", async (_n, retire) => {
    const w = await paidWorld();
    const a = await withPrerequisite(w);
    await retire(w, a.id);

    expect((await order(w.course.slug)).status).toBe(200);
    expect(createOrder).toHaveBeenCalledTimes(1);
  });

  it("no prerequisites: the order is created exactly as before", async () => {
    const w = await paidWorld();

    expect((await order(w.course.slug)).status).toBe(200);
    expect(createOrder).toHaveBeenCalledTimes(1);
  });

  it("existing answers come first: already enrolled is still 409 'Already enrolled', and no order", async () => {
    const w = await paidWorld();
    await withPrerequisite(w);
    await w.enroll(w.learner.user.id, w.course.id, "ACTIVE");

    const res = await order(w.course.slug);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Already enrolled" });
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("a learner of another tenant still gets 404 (nothing about prerequisites is revealed), and a free course is still 400", async () => {
    const w = await paidWorld();
    await withPrerequisite(w);
    const outsider = await createScenario();
    vi.mocked(auth).mockResolvedValue({ userId: outsider.learner.user.clerkId } as never);
    expect((await order(w.course.slug)).status).toBe(404);

    vi.mocked(auth).mockResolvedValue({ userId: w.learner.user.clerkId } as never);
    await w.setPrice(w.course.id, 0);
    expect((await order(w.course.slug)).status).toBe(400);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("a prerequisite of another tenant cannot stop the order", async () => {
    const w = await paidWorld();
    const foreign = await prerequisiteWorld();
    await w.requires(w.course.id, foreign.course.id);

    expect((await order(w.course.slug)).status).toBe(200);
  });

  it("five simultaneous order requests with an unmet prerequisite create no payment order at all", async () => {
    const w = await paidWorld();
    await withPrerequisite(w);

    const responses = await Promise.all(Array.from({ length: 5 }, () => order(w.course.slug)));

    expect(responses.map((r) => r.status)).toEqual(Array(5).fill(409));
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("completing the prerequisite is what unlocks the order: refused, then allowed", async () => {
    const w = await paidWorld();
    const a = await withPrerequisite(w);
    await w.enroll(w.learner.user.id, a.id, "ACTIVE");

    expect((await order(w.course.slug)).status).toBe(409);
    expect(createOrder).not.toHaveBeenCalled();
    await w.completeExisting(w.learner.user.id, a.id);
    expect((await order(w.course.slug)).status).toBe(200);
    expect(createOrder).toHaveBeenCalledTimes(1);
  });
});
