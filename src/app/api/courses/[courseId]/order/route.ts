import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";

import { prerequisitesNotMetResponse } from "@/lib/course-prerequisite-api";
import { db } from "@/lib/db";
import { canEnrollInCourse } from "@/lib/domain/course/enrollmentAccess";
import { courseOrderNotes, courseOrderReceipt } from "@/lib/domain/course/paymentVerification";
import {
  assertCoursePrerequisitesMet,
  PrerequisitesNotMetError,
} from "@/lib/domain/course/prerequisites";
import { razorpay } from "@/lib/razorpay";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ courseId: string }> }
) {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { courseId } = await params;

  const user = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true, role: true, tenantId: true },
  });

  if (!user || user.role !== "STUDENT") {
    return Response.json({ error: "Only students can purchase courses" }, { status: 403 });
  }

  const course = await db.course.findUnique({
    where: { slug: courseId },
    select: {
      id: true,
      title: true,
      price: true,
      currency: true,
      status: true,
      tenantId: true,
    },
  });

  if (!course || course.status !== "PUBLISHED") {
    return Response.json({ error: "Course not found" }, { status: 404 });
  }

  // Same rule as enroll: a payment order for a course the buyer cannot enroll in
  // would take their money and then be refused at enrollment. Checked before
  // any Razorpay call.
  if (!canEnrollInCourse(course.tenantId, user.tenantId)) {
    return Response.json({ error: "Course not found" }, { status: 404 });
  }

  if (course.price === 0) {
    return Response.json({ error: "Course is free — no order needed" }, { status: 400 });
  }

  const existing = await db.enrollment.findUnique({
    where: { userId_courseId: { userId: user.id, courseId: course.id } },
  });

  if (existing) {
    return Response.json({ error: "Already enrolled" }, { status: 409 });
  }

  // A learner who cannot enroll must not cause a payment order to exist: the
  // prerequisites are decided before anything is sent to Razorpay.
  try {
    await assertCoursePrerequisitesMet(db, { userId: user.id, courseId: course.id });
  } catch (err) {
    if (err instanceof PrerequisitesNotMetError) return prerequisitesNotMetResponse(err);
    throw err;
  }

  // Receipt/notes are the trusted record enroll/route.ts verifies a payment
  // against (paymentVerification.ts) — keep them derived from one place.
  const order = await razorpay.orders.create({
    amount: Math.round(course.price * 100),
    currency: course.currency,
    receipt: courseOrderReceipt(course.id, user.id),
    notes: courseOrderNotes(course.id, user.id),
  });

  return Response.json({
    orderId: order.id,
    amount: order.amount,
    currency: order.currency,
    razorpayKeyId: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
  });
}
