import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { db, razorpay, resend } from "@/lib";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ courseId: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { courseId } = await params;

  const user = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true, email: true, name: true, role: true },
  });

  if (!user || user.role !== "STUDENT") {
    return Response.json(
      { error: "Only students can enroll" },
      { status: 403 },
    );
  }

  const course = await db.course.findUnique({
    where: { id: courseId },
    select: {
      id: true,
      title: true,
      price: true,
      currency: true,
      status: true,
    },
  });

  if (!course || course.status !== "PUBLISHED") {
    return Response.json({ error: "Course not found" }, { status: 404 });
  }

  const existing = await db.enrollment.findUnique({
    where: { userId_courseId: { userId: user.id, courseId } },
  });

  if (existing) {
    return Response.json({ error: "Already enrolled" }, { status: 409 });
  }

  let body: { razorpayPaymentId?: string } = {};
  try {
    body = await req.json();
  } catch {
    // empty body is valid for free courses
  }

  if (course.price > 0) {
    if (!body.razorpayPaymentId) {
      return Response.json(
        { error: "razorpayPaymentId required for paid courses" },
        { status: 400 },
      );
    }

    type PaymentResult = {
      status: string;
      amount: number | string;
      currency: string;
    };
    let payment: PaymentResult;
    try {
      payment = (await razorpay.payments.fetch(
        body.razorpayPaymentId,
      )) as unknown as PaymentResult;
    } catch {
      return Response.json({ error: "Invalid payment ID" }, { status: 402 });
    }

    if (payment.status !== "captured") {
      return Response.json({ error: "Payment not captured" }, { status: 402 });
    }

    if (
      Number(payment.amount) !== Math.round(course.price * 100) ||
      payment.currency !== course.currency
    ) {
      return Response.json(
        { error: "Payment amount mismatch" },
        { status: 402 },
      );
    }
  }

  const enrollment = await db.enrollment.create({
    data: { userId: user.id, courseId },
    select: {
      id: true,
      status: true,
      userId: true,
      courseId: true,
      createdAt: true,
    },
  });

  // Fire-and-forget — email failure must not roll back the enrollment
  resend.emails
    .send({
      from: "Lumio <hello@lumio.io>",
      to: user.email,
      subject: `You're enrolled in "${course.title}"`,
      html: `<p>Hi ${user.name ?? "there"},</p><p>You're now enrolled in <strong>${course.title}</strong>. Jump in and start learning at your own pace.</p><p>— The Lumio Team</p>`,
    })
    .catch(() => {});

  return Response.json(enrollment, { status: 201 });
}
