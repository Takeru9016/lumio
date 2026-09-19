import { auth } from "@clerk/nextjs/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { createCourse } from "@/lib/domain/capability/__test__/fixtures";
import { createUserInTenant } from "@/lib/domain/course/__test__/fixtures";
import { courseOrderNotes, courseOrderReceipt } from "@/lib/domain/course/paymentVerification";
import { createTenantUser } from "@/lib/domain/knowledge/__test__/fixtures";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));
vi.mock("@/lib/razorpay", () => ({ razorpay: { orders: { create: vi.fn() } } }));

const { razorpay } = await import("@/lib/razorpay");
const { POST } = await import("./route");

const createOrder = vi.mocked(razorpay.orders.create) as unknown as ReturnType<typeof vi.fn>;

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

describe("POST /api/courses/[courseId]/order", () => {
  it("creates the order with the exact receipt the enroll route verifies, plus full-id notes", async () => {
    const { tenant, user: instructor } = await createTenantUser("INSTRUCTOR");
    const student = await createUserInTenant(tenant.id, "STUDENT");
    const { course } = await createCourse(tenant.id, instructor.id);
    await db.course.update({
      where: { id: course.id },
      data: { price: 499, currency: "INR", status: "PUBLISHED" },
    });
    vi.mocked(auth).mockResolvedValue({ userId: student.clerkId } as never);

    const res = await POST(new Request("http://localhost/x", { method: "POST" }) as never, {
      params: Promise.resolve({ courseId: course.slug }),
    });

    expect(res.status).toBe(200);
    expect(createOrder).toHaveBeenCalledWith({
      amount: 49900,
      currency: "INR",
      receipt: courseOrderReceipt(course.id, student.id),
      notes: courseOrderNotes(course.id, student.id),
    });
  });
});
