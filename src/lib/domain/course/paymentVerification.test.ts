import { describe, expect, it, vi } from "vitest";
import {
  courseOrderNotes,
  courseOrderReceipt,
  PaymentVerificationError,
  verifyCoursePayment,
} from "@/lib/domain/course/paymentVerification";

const COURSE = { id: "c".repeat(25), price: 499, currency: "INR" };
const USER_ID = "u".repeat(25);
const OTHER_USER_ID = "z".repeat(25);
const OTHER_COURSE_ID = "d".repeat(25);

type Overrides = {
  payment?: Record<string, unknown> | Error;
  order?: Record<string, unknown> | Error;
};

function client({ payment, order }: Overrides = {}) {
  const goodPayment = {
    id: "pay_1",
    status: "captured",
    amount: 49900,
    currency: "INR",
    order_id: "order_1",
  };
  const goodOrder = {
    id: "order_1",
    amount: 49900,
    currency: "INR",
    receipt: courseOrderReceipt(COURSE.id, USER_ID),
    notes: courseOrderNotes(COURSE.id, USER_ID),
  };
  const fetchPayment = vi.fn(async () => {
    if (payment instanceof Error) throw payment;
    return { ...goodPayment, ...payment };
  });
  const fetchOrder = vi.fn(async () => {
    if (order instanceof Error) throw order;
    return { ...goodOrder, ...order };
  });
  return { payments: { fetch: fetchPayment }, orders: { fetch: fetchOrder } };
}

const verify = (c: ReturnType<typeof client>, paymentId: unknown = "pay_1", userId = USER_ID) =>
  verifyCoursePayment(c, { paymentId, course: COURSE, userId });

async function expectDenied(promise: Promise<void>, status: 400 | 402, message?: string) {
  const err = await promise.then(
    () => null,
    (e) => e
  );
  expect(err).toBeInstanceOf(PaymentVerificationError);
  expect(err.status).toBe(status);
  if (message) expect(err.message).toBe(message);
}

describe("verifyCoursePayment", () => {
  it("accepts a captured payment whose order was created for this user and course", async () => {
    await expect(verify(client())).resolves.toBeUndefined();
  });

  it("denies a payment made for ANOTHER course (order receipt/notes name a different course)", async () => {
    const c = client({
      order: {
        receipt: courseOrderReceipt(OTHER_COURSE_ID, USER_ID),
        notes: courseOrderNotes(OTHER_COURSE_ID, USER_ID),
      },
    });
    await expectDenied(verify(c), 402, "Payment does not match this purchase");
  });

  it("denies a payment belonging to ANOTHER user", async () => {
    const c = client({
      order: {
        receipt: courseOrderReceipt(COURSE.id, OTHER_USER_ID),
        notes: courseOrderNotes(COURSE.id, OTHER_USER_ID),
      },
    });
    await expectDenied(verify(c), 402, "Payment does not match this purchase");
  });

  it("denies when the full-id notes disagree even though the truncated receipt matches (same 12-char user prefix)", async () => {
    const collidingUser = USER_ID.slice(0, 12) + "y".repeat(13);
    expect(courseOrderReceipt(COURSE.id, collidingUser)).toBe(
      courseOrderReceipt(COURSE.id, USER_ID)
    );
    const c = client({ order: { notes: courseOrderNotes(COURSE.id, collidingUser) } });
    await expectDenied(verify(c), 402, "Payment does not match this purchase");
  });

  it("denies a payment with the wrong order (order id differs from the payment's order_id)", async () => {
    await expectDenied(verify(client({ order: { id: "order_OTHER" } })), 402);
  });

  it("denies a payment without order binding (no order_id) — never falls back to amount-only", async () => {
    const c = client({ payment: { order_id: undefined } });
    await expectDenied(verify(c), 402, "Payment does not match this purchase");
    expect(c.orders.fetch).not.toHaveBeenCalled();
    await expectDenied(verify(client({ payment: { order_id: null } })), 402);
    await expectDenied(verify(client({ payment: { order_id: "" } })), 402);
  });

  it("denies when the order cannot be fetched", async () => {
    await expectDenied(verify(client({ order: new Error("nope") })), 402);
  });

  it("denies wrong payment amount and wrong order amount", async () => {
    await expectDenied(
      verify(client({ payment: { amount: 100 } })),
      402,
      "Payment amount mismatch"
    );
    await expectDenied(verify(client({ order: { amount: 100 } })), 402, "Payment amount mismatch");
  });

  it("denies wrong currency on payment and on order", async () => {
    await expectDenied(
      verify(client({ payment: { currency: "USD" } })),
      402,
      "Payment amount mismatch"
    );
    await expectDenied(
      verify(client({ order: { currency: "USD" } })),
      402,
      "Payment amount mismatch"
    );
  });

  it("denies an uncaptured payment (and does not look up the order)", async () => {
    const c = client({ payment: { status: "authorized" } });
    await expectDenied(verify(c), 402, "Payment not captured");
    expect(c.orders.fetch).not.toHaveBeenCalled();
  });

  it("denies a forged / unknown payment id", async () => {
    await expectDenied(
      verify(client({ payment: new Error("not found") }), "pay_forged"),
      402,
      "Invalid payment ID"
    );
  });

  it("returns 400 for a missing or non-string payment id", async () => {
    await expectDenied(verify(client(), null), 400);
    await expectDenied(verify(client(), ""), 400);
    await expectDenied(verify(client(), 123), 400);
    await expectDenied(verify(client(), {}), 400);
  });

  it("legacy orders (no notes, e.g. `[]` from Razorpay) are verified by the receipt alone", async () => {
    await expect(verify(client({ order: { notes: [] } }))).resolves.toBeUndefined();
    await expect(verify(client({ order: { notes: undefined } }))).resolves.toBeUndefined();
  });

  it("legacy orders with a wrong receipt still fail closed", async () => {
    const c = client({ order: { notes: [], receipt: "c_something_else" } });
    await expectDenied(verify(c), 402);
  });

  it("denies a missing receipt", async () => {
    await expectDenied(verify(client({ order: { receipt: undefined, notes: [] } })), 402);
  });
});

describe("courseOrderReceipt / courseOrderNotes", () => {
  it("preserves the existing receipt format (c_<courseId>_<userId>, max 40 chars)", () => {
    expect(courseOrderReceipt("course1", "user1")).toBe("c_course1_user1");
    expect(courseOrderReceipt(COURSE.id, USER_ID)).toHaveLength(40);
    expect(courseOrderReceipt(COURSE.id, USER_ID).startsWith(`c_${COURSE.id}_`)).toBe(true);
  });

  it("notes carry the full, untruncated ids", () => {
    expect(courseOrderNotes(COURSE.id, USER_ID)).toEqual({ courseId: COURSE.id, userId: USER_ID });
  });
});
