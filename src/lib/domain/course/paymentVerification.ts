/**
 * Course-purchase payment binding (Phase 23).
 *
 * A captured payment of the right amount is NOT proof that it was made for
 * this course by this user — Razorpay payment ids are not secrets and one
 * account's payments are fetchable with the same API key. The proof is the
 * Razorpay ORDER: /api/courses/[courseId]/order creates it server-side for the
 * authenticated user and the requested course, so its receipt/notes are a
 * trusted record of who the purchase was for. Enrollment must therefore go
 * payment -> order_id -> order -> (receipt/notes == this user + this course).
 *
 * Binding strength differs by order age. Orders created since Phase 23 carry
 * the full course and user ids in `notes`, which are checked exactly. Orders
 * created earlier have only the receipt, which holds the full course id but
 * just a 12-character prefix of the user id, so for those the user binding is
 * a compatibility check, not a proof: two users sharing a 12-character id
 * prefix would both satisfy the same legacy order. They are still accepted so
 * in-flight purchases are not broken.
 */

type RazorpayLike = {
  payments: { fetch(paymentId: string): Promise<unknown> };
  orders: { fetch(orderId: string): Promise<unknown> };
};

export class PaymentVerificationError extends Error {
  constructor(
    public status: 400 | 402,
    message: string
  ) {
    super(message);
    this.name = "PaymentVerificationError";
  }
}

const MISMATCH = "Payment does not match this purchase";

/**
 * The single definition of the receipt the order route writes and this file
 * verifies. Razorpay caps receipts at 40 characters, so it keeps the full
 * course id but only a 12-character prefix of the user id — see
 * courseOrderNotes for the unambiguous binding used on new orders.
 */
export function courseOrderReceipt(courseId: string, userId: string): string {
  return `c_${courseId}_${userId}`.slice(0, 40);
}

/** Full, untruncated ids stored on every new order. */
export function courseOrderNotes(courseId: string, userId: string) {
  return { courseId, userId };
}

type PaymentShape = {
  status?: unknown;
  amount?: unknown;
  currency?: unknown;
  order_id?: unknown;
};

type OrderShape = {
  id?: unknown;
  amount?: unknown;
  currency?: unknown;
  receipt?: unknown;
  notes?: unknown;
};

export async function verifyCoursePayment(
  client: RazorpayLike,
  params: {
    paymentId: unknown;
    course: { id: string; price: number; currency: string };
    userId: string;
  }
): Promise<void> {
  const { paymentId, course, userId } = params;

  if (typeof paymentId !== "string" || paymentId.length === 0) {
    throw new PaymentVerificationError(400, "razorpayPaymentId required for paid courses");
  }

  let payment: PaymentShape;
  try {
    payment = (await client.payments.fetch(paymentId)) as PaymentShape;
  } catch {
    throw new PaymentVerificationError(402, "Invalid payment ID");
  }

  if (payment.status !== "captured") {
    throw new PaymentVerificationError(402, "Payment not captured");
  }

  const expectedAmount = Math.round(course.price * 100);
  if (Number(payment.amount) !== expectedAmount || payment.currency !== course.currency) {
    throw new PaymentVerificationError(402, "Payment amount mismatch");
  }

  // A payment made without an Order carries no trusted purchaser/course
  // record — fail closed rather than fall back to amount-only matching.
  const orderId = payment.order_id;
  if (typeof orderId !== "string" || orderId.length === 0) {
    throw new PaymentVerificationError(402, MISMATCH);
  }

  let order: OrderShape;
  try {
    order = (await client.orders.fetch(orderId)) as OrderShape;
  } catch {
    throw new PaymentVerificationError(402, MISMATCH);
  }

  if (order.id !== orderId) {
    throw new PaymentVerificationError(402, MISMATCH);
  }
  if (Number(order.amount) !== expectedAmount || order.currency !== course.currency) {
    throw new PaymentVerificationError(402, "Payment amount mismatch");
  }

  if (order.receipt !== courseOrderReceipt(course.id, userId)) {
    throw new PaymentVerificationError(402, MISMATCH);
  }

  // New orders also carry the full ids in `notes`; when present they must
  // match exactly. Orders created before notes existed have only the
  // (truncated) receipt above — see the legacy-order note in the file header.
  const notes =
    order.notes && typeof order.notes === "object" && !Array.isArray(order.notes)
      ? (order.notes as Record<string, unknown>)
      : null;
  if (notes && ("courseId" in notes || "userId" in notes)) {
    if (String(notes.courseId) !== course.id || String(notes.userId) !== userId) {
      throw new PaymentVerificationError(402, MISMATCH);
    }
  }
}
