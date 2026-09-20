import { auth } from "@clerk/nextjs/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { createCourse } from "@/lib/domain/capability/__test__/fixtures";
import { createSoloUser, createUserInTenant } from "@/lib/domain/course/__test__/fixtures";
import {
  authorizeLessonSummaryAccess,
  ContentAuthorizationError,
} from "@/lib/domain/course/contentAuthorization";
import { courseOrderNotes, courseOrderReceipt } from "@/lib/domain/course/paymentVerification";
import { createTenantUser } from "@/lib/domain/knowledge/__test__/fixtures";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));
vi.mock("@/lib/razorpay", () => ({
  razorpay: { payments: { fetch: vi.fn() }, orders: { fetch: vi.fn() } },
}));
vi.mock("@/lib/resend", () => ({
  resend: { emails: { send: vi.fn().mockResolvedValue({}) } },
}));

const { razorpay } = await import("@/lib/razorpay");
const { POST } = await import("./route");

const fetchPayment = vi.mocked(razorpay.payments.fetch) as unknown as ReturnType<typeof vi.fn>;
const fetchOrder = vi.mocked(razorpay.orders.fetch) as unknown as ReturnType<typeof vi.fn>;

const call = (slug: string, body?: unknown) =>
  POST(
    new Request("http://localhost/x", {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ courseId: slug }) }
  );

async function setup() {
  const { tenant, user: instructor } = await createTenantUser("INSTRUCTOR");
  const student = await createUserInTenant(tenant.id, "STUDENT");
  const { course } = await createCourse(tenant.id, instructor.id);
  await db.course.update({
    where: { id: course.id },
    data: { price: 499, currency: "INR", status: "PUBLISHED" },
  });
  return { tenant, instructor, student, course };
}

function mockRazorpay(opts: {
  courseId: string;
  userId: string;
  payment?: Record<string, unknown> | Error;
  order?: Record<string, unknown> | Error;
}) {
  fetchPayment.mockImplementation(async () => {
    if (opts.payment instanceof Error) throw opts.payment;
    return {
      id: "pay_1",
      status: "captured",
      amount: 49900,
      currency: "INR",
      order_id: "order_1",
      ...opts.payment,
    };
  });
  fetchOrder.mockImplementation(async () => {
    if (opts.order instanceof Error) throw opts.order;
    return {
      id: "order_1",
      amount: 49900,
      currency: "INR",
      receipt: courseOrderReceipt(opts.courseId, opts.userId),
      notes: courseOrderNotes(opts.courseId, opts.userId),
      ...opts.order,
    };
  });
}

const enrollmentCount = (userId: string, courseId: string) =>
  db.enrollment.count({ where: { userId, courseId } });

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

describe("POST /api/courses/[courseId]/enroll — paid course payment binding", () => {
  it("valid captured payment for the correct order/course/user -> 201 and an enrollment", async () => {
    const { student, course } = await setup();
    vi.mocked(auth).mockResolvedValue({ userId: student.clerkId } as never);
    mockRazorpay({ courseId: course.id, userId: student.id });

    const res = await call(course.slug, { razorpayPaymentId: "pay_1" });

    expect(res.status).toBe(201);
    expect(await enrollmentCount(student.id, course.id)).toBe(1);
    expect(fetchOrder).toHaveBeenCalledWith("order_1");
  });

  it("a valid payment made for ANOTHER course is denied and grants no enrollment", async () => {
    const { student, course } = await setup();
    vi.mocked(auth).mockResolvedValue({ userId: student.clerkId } as never);
    mockRazorpay({ courseId: "some-other-course-id", userId: student.id });

    const res = await call(course.slug, { razorpayPaymentId: "pay_1" });

    expect(res.status).toBe(402);
    expect(await enrollmentCount(student.id, course.id)).toBe(0);
  });

  it("a valid payment belonging to ANOTHER user is denied (replay across accounts)", async () => {
    const { tenant, student, course } = await setup();
    const victim = await createUserInTenant(tenant.id, "STUDENT");
    vi.mocked(auth).mockResolvedValue({ userId: student.clerkId } as never);
    mockRazorpay({ courseId: course.id, userId: victim.id });

    const res = await call(course.slug, { razorpayPaymentId: "pay_1" });

    expect(res.status).toBe(402);
    expect(await enrollmentCount(student.id, course.id)).toBe(0);
  });

  it("a payment with the wrong order is denied", async () => {
    const { student, course } = await setup();
    vi.mocked(auth).mockResolvedValue({ userId: student.clerkId } as never);
    mockRazorpay({ courseId: course.id, userId: student.id, order: { id: "order_OTHER" } });

    const res = await call(course.slug, { razorpayPaymentId: "pay_1" });

    expect(res.status).toBe(402);
    expect(await enrollmentCount(student.id, course.id)).toBe(0);
  });

  it("a payment without order binding is denied (no amount-only fallback)", async () => {
    const { student, course } = await setup();
    vi.mocked(auth).mockResolvedValue({ userId: student.clerkId } as never);
    mockRazorpay({ courseId: course.id, userId: student.id, payment: { order_id: null } });

    const res = await call(course.slug, { razorpayPaymentId: "pay_1" });

    expect(res.status).toBe(402);
    expect(await enrollmentCount(student.id, course.id)).toBe(0);
    expect(fetchOrder).not.toHaveBeenCalled();
  });

  it("wrong amount -> 402", async () => {
    const { student, course } = await setup();
    vi.mocked(auth).mockResolvedValue({ userId: student.clerkId } as never);
    mockRazorpay({ courseId: course.id, userId: student.id, payment: { amount: 100 } });

    const res = await call(course.slug, { razorpayPaymentId: "pay_1" });

    expect(res.status).toBe(402);
    expect(await enrollmentCount(student.id, course.id)).toBe(0);
  });

  it("wrong currency -> 402", async () => {
    const { student, course } = await setup();
    vi.mocked(auth).mockResolvedValue({ userId: student.clerkId } as never);
    mockRazorpay({ courseId: course.id, userId: student.id, payment: { currency: "USD" } });

    const res = await call(course.slug, { razorpayPaymentId: "pay_1" });

    expect(res.status).toBe(402);
    expect(await enrollmentCount(student.id, course.id)).toBe(0);
  });

  it("an uncaptured payment -> 402", async () => {
    const { student, course } = await setup();
    vi.mocked(auth).mockResolvedValue({ userId: student.clerkId } as never);
    mockRazorpay({ courseId: course.id, userId: student.id, payment: { status: "authorized" } });

    const res = await call(course.slug, { razorpayPaymentId: "pay_1" });

    expect(res.status).toBe(402);
    expect(await enrollmentCount(student.id, course.id)).toBe(0);
  });

  it("a forged / client-only payment id cannot grant access, and a missing id is a 400", async () => {
    const { student, course } = await setup();
    vi.mocked(auth).mockResolvedValue({ userId: student.clerkId } as never);
    mockRazorpay({
      courseId: course.id,
      userId: student.id,
      payment: new Error("no such payment"),
    });

    const forged = await call(course.slug, { razorpayPaymentId: "pay_forged" });
    const missing = await call(course.slug, {});

    expect(forged.status).toBe(402);
    expect(missing.status).toBe(400);
    expect(await enrollmentCount(student.id, course.id)).toBe(0);
  });

  it("duplicate enrollment keeps the existing 409 and never reaches Razorpay", async () => {
    const { student, course } = await setup();
    await db.enrollment.create({ data: { userId: student.id, courseId: course.id } });
    vi.mocked(auth).mockResolvedValue({ userId: student.clerkId } as never);
    mockRazorpay({ courseId: course.id, userId: student.id });

    const res = await call(course.slug, { razorpayPaymentId: "pay_1" });

    expect(res.status).toBe(409);
    expect(fetchPayment).not.toHaveBeenCalled();
  });

  it("existing auth/role/status behavior is unchanged (401 / 403 / 404)", async () => {
    const { tenant, instructor, student, course } = await setup();
    const draft = await createCourse(tenant.id, instructor.id);

    vi.mocked(auth).mockResolvedValue({ userId: null } as never);
    expect((await call(course.slug)).status).toBe(401);

    vi.mocked(auth).mockResolvedValue({ userId: instructor.clerkId } as never);
    expect((await call(course.slug)).status).toBe(403);

    vi.mocked(auth).mockResolvedValue({ userId: student.clerkId } as never);
    expect((await call(draft.course.slug, {})).status).toBe(404);
  });
});

describe("POST /api/courses/[courseId]/enroll — free course (unchanged)", () => {
  it("enrolls without any payment and never calls Razorpay", async () => {
    const { student, course } = await setup();
    await db.course.update({ where: { id: course.id }, data: { price: 0 } });
    vi.mocked(auth).mockResolvedValue({ userId: student.clerkId } as never);

    const res = await call(course.slug);

    expect(res.status).toBe(201);
    expect(fetchPayment).not.toHaveBeenCalled();
    expect(await enrollmentCount(student.id, course.id)).toBe(1);
  });
});

describe("POST /api/courses/[courseId]/enroll — tenant isolation", () => {
  /** A published, free course owned by `tenantId` (null = the open catalogue). */
  async function publishedCourse(tenantId: string | null, price = 0) {
    const { tenant, user: instructor } = await createTenantUser("INSTRUCTOR");
    const { course, lesson } = await createCourse(tenant.id, instructor.id);
    await db.course.update({
      where: { id: course.id },
      data: { price, currency: "INR", status: "PUBLISHED", tenantId },
    });
    return { course, lesson, instructor, ownerTenantId: tenant.id };
  }

  it("rejects a learner from another tenant: 404, no enrollment, and no Razorpay call", async () => {
    const { course } = await publishedCourse(null);
    const owner = await createTenantUser("INSTRUCTOR");
    await db.course.update({ where: { id: course.id }, data: { tenantId: owner.tenant.id } });
    const { tenant: otherTenant } = await createTenantUser("ORG_ADMIN");
    const outsider = await createUserInTenant(otherTenant.id, "STUDENT");
    vi.mocked(auth).mockResolvedValue({ userId: outsider.clerkId } as never);

    const res = await call(course.slug);

    expect(res.status).toBe(404);
    expect(await enrollmentCount(outsider.id, course.id)).toBe(0);
    expect(fetchPayment).not.toHaveBeenCalled();
  });

  it("rejects a cross-tenant learner on a PAID course before any payment is verified", async () => {
    const { course, ownerTenantId } = await publishedCourse(null, 499);
    await db.course.update({ where: { id: course.id }, data: { tenantId: ownerTenantId } });
    const { tenant: otherTenant } = await createTenantUser("ORG_ADMIN");
    const outsider = await createUserInTenant(otherTenant.id, "STUDENT");
    vi.mocked(auth).mockResolvedValue({ userId: outsider.clerkId } as never);
    mockRazorpay({ courseId: course.id, userId: outsider.id });

    const res = await call(course.slug, { razorpayPaymentId: "pay_1" });

    expect(res.status).toBe(404);
    expect(await enrollmentCount(outsider.id, course.id)).toBe(0);
    expect(fetchPayment).not.toHaveBeenCalled();
    expect(fetchOrder).not.toHaveBeenCalled();
  });

  it("rejects a learner with no tenant from a tenant-owned course", async () => {
    const { course, ownerTenantId } = await publishedCourse(null);
    await db.course.update({ where: { id: course.id }, data: { tenantId: ownerTenantId } });
    const solo = await createSoloUser("STUDENT");
    vi.mocked(auth).mockResolvedValue({ userId: solo.clerkId } as never);

    const res = await call(course.slug);

    expect(res.status).toBe(404);
    expect(await enrollmentCount(solo.id, course.id)).toBe(0);
  });

  it("still enrolls a learner of the course's own tenant", async () => {
    const { course, ownerTenantId } = await publishedCourse(null);
    await db.course.update({ where: { id: course.id }, data: { tenantId: ownerTenantId } });
    const member = await createUserInTenant(ownerTenantId, "STUDENT");
    vi.mocked(auth).mockResolvedValue({ userId: member.clerkId } as never);

    const res = await call(course.slug);

    expect(res.status).toBe(201);
    expect(await enrollmentCount(member.id, course.id)).toBe(1);
  });

  it("still enrolls learners of any tenant, and learners with none, in a tenantless course", async () => {
    const { course } = await publishedCourse(null);
    expect((await db.course.findUniqueOrThrow({ where: { id: course.id } })).tenantId).toBeNull();
    const { tenant: someTenant } = await createTenantUser("ORG_ADMIN");
    const member = await createUserInTenant(someTenant.id, "STUDENT");
    const solo = await createSoloUser("STUDENT");

    for (const learner of [member, solo]) {
      vi.mocked(auth).mockResolvedValue({ userId: learner.clerkId } as never);
      const res = await call(course.slug);
      expect(res.status).toBe(201);
      expect(await enrollmentCount(learner.id, course.id)).toBe(1);
    }
  });

  it("leaves an enrollment created before this rule exactly as it was", async () => {
    const { course, ownerTenantId } = await publishedCourse(null);
    await db.course.update({ where: { id: course.id }, data: { tenantId: ownerTenantId } });
    const { tenant: otherTenant } = await createTenantUser("ORG_ADMIN");
    const legacy = await createUserInTenant(otherTenant.id, "STUDENT");
    const before = await db.enrollment.create({ data: { userId: legacy.id, courseId: course.id } });
    vi.mocked(auth).mockResolvedValue({ userId: legacy.clerkId } as never);

    const res = await call(course.slug);

    expect(res.status).toBe(404);
    expect(await db.enrollment.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before);
  });

  it("does not change publication rules: an unpublished course stays 404 for its own tenant", async () => {
    const { course, ownerTenantId } = await publishedCourse(null);
    await db.course.update({
      where: { id: course.id },
      data: { tenantId: ownerTenantId, status: "DRAFT" },
    });
    const member = await createUserInTenant(ownerTenantId, "STUDENT");
    vi.mocked(auth).mockResolvedValue({ userId: member.clerkId } as never);

    expect((await call(course.slug)).status).toBe(404);
    expect(await enrollmentCount(member.id, course.id)).toBe(0);
  });
});

describe("enrollment -> lesson access -> AI summary chain", () => {
  async function tenantCourse(status: "PUBLISHED" | "DRAFT" | "ARCHIVED" = "PUBLISHED") {
    const { tenant, user: instructor } = await createTenantUser("INSTRUCTOR");
    const { course, lesson } = await createCourse(tenant.id, instructor.id);
    await db.course.update({ where: { id: course.id }, data: { price: 0, status } });
    return { tenant, course, lesson };
  }

  const summaryStatus = async (user: { id: string; tenantId: string | null }, lessonId: string) => {
    try {
      await authorizeLessonSummaryAccess(user, lessonId);
      return 200;
    } catch (err) {
      if (err instanceof ContentAuthorizationError) return err.status;
      throw err;
    }
  };

  it("a cross-tenant learner cannot reach the lesson summary by trying to enroll", async () => {
    const { course, lesson } = await tenantCourse();
    const { tenant: otherTenant } = await createTenantUser("ORG_ADMIN");
    const outsider = await createUserInTenant(otherTenant.id, "STUDENT");
    vi.mocked(auth).mockResolvedValue({ userId: outsider.clerkId } as never);

    const res = await call(course.slug);

    expect(res.status).toBe(404);
    expect(await summaryStatus(outsider, lesson.id)).toBe(404);
  });

  it("a same-tenant learner enrolls and can then read the lesson summary", async () => {
    const { tenant, course, lesson } = await tenantCourse();
    const member = await createUserInTenant(tenant.id, "STUDENT");
    // In the tenant but not enrolled: the course is visible, the paid lesson is not.
    expect(await summaryStatus(member, lesson.id)).toBe(403);
    vi.mocked(auth).mockResolvedValue({ userId: member.clerkId } as never);

    expect((await call(course.slug)).status).toBe(201);

    expect(await summaryStatus(member, lesson.id)).toBe(200);
  });

  it("a learner with no tenant enrolls in a tenantless course and reaches its summary", async () => {
    const { course, lesson } = await tenantCourse();
    await db.course.update({ where: { id: course.id }, data: { tenantId: null } });
    const solo = await createSoloUser("STUDENT");
    vi.mocked(auth).mockResolvedValue({ userId: solo.clerkId } as never);

    expect((await call(course.slug)).status).toBe(201);

    expect(await summaryStatus(solo, lesson.id)).toBe(200);
  });

  it("an existing valid enrollment keeps its access", async () => {
    const { tenant, course, lesson } = await tenantCourse();
    const member = await createUserInTenant(tenant.id, "STUDENT");
    await db.enrollment.create({ data: { userId: member.id, courseId: course.id } });

    expect(await summaryStatus(member, lesson.id)).toBe(200);
  });

  it("an unpublished course cannot be enrolled in, and reaches no summary", async () => {
    const { tenant, course, lesson } = await tenantCourse("DRAFT");
    const member = await createUserInTenant(tenant.id, "STUDENT");
    vi.mocked(auth).mockResolvedValue({ userId: member.clerkId } as never);

    expect((await call(course.slug)).status).toBe(404);

    expect(await summaryStatus(member, lesson.id)).toBe(404);
  });

  it("an archived course cannot gain new enrollments, but an existing enrollment keeps access", async () => {
    const { tenant, course, lesson } = await tenantCourse("ARCHIVED");
    const newcomer = await createUserInTenant(tenant.id, "STUDENT");
    vi.mocked(auth).mockResolvedValue({ userId: newcomer.clerkId } as never);
    expect((await call(course.slug)).status).toBe(404);
    expect(await summaryStatus(newcomer, lesson.id)).toBe(404);

    const enrolled = await createUserInTenant(tenant.id, "STUDENT");
    await db.enrollment.create({ data: { userId: enrolled.id, courseId: course.id } });
    expect(await summaryStatus(enrolled, lesson.id)).toBe(200);
  });
});
