import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";

import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { canEnrollInCourse } from "@/lib/domain/course/enrollmentAccess";
import {
  PaymentVerificationError,
  verifyCoursePayment,
} from "@/lib/domain/course/paymentVerification";
import { EnrollmentEmail } from "@/lib/emails/enrollment";
import { razorpay } from "@/lib/razorpay";
import { resend } from "@/lib/resend";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ courseId: string }> }
) {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { courseId } = await params;

  const user = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true, email: true, name: true, role: true, tenantId: true },
  });

  if (!user || user.role !== "STUDENT") {
    return Response.json({ error: "Only students can enroll" }, { status: 403 });
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

  // A tenant-owned course is enrollable only by that tenant's members. The same
  // 404 as an unpublished course, so another organisation's course cannot be
  // probed for, and checked before the existing-enrollment lookup and payment
  // verification. A course with no tenant stays open to everyone.
  if (!canEnrollInCourse(course.tenantId, user.tenantId)) {
    return Response.json({ error: "Course not found" }, { status: 404 });
  }

  const existing = await db.enrollment.findUnique({
    where: { userId_courseId: { userId: user.id, courseId: course.id } },
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
    // Payment must be proven to belong to THIS user and THIS course via its
    // Razorpay Order (see paymentVerification.ts) — a captured payment of the
    // right amount alone is replayable across courses and accounts.
    try {
      await verifyCoursePayment(razorpay, {
        paymentId: body.razorpayPaymentId,
        course,
        userId: user.id,
      });
    } catch (err) {
      if (err instanceof PaymentVerificationError) {
        return Response.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }
  }

  // The existence check above and this insert are not atomic. If a concurrent
  // request (a double click, or an organisation assigning this course) created
  // the row in between, the (userId, courseId) unique index rejects this insert
  // — which is the same "already enrolled" answer as the check. Only a unique
  // violation on this one statement is treated that way; it touches a single
  // table with a single non-primary unique index, so it cannot be mistaken for
  // another constraint. Any other error still surfaces.
  let enrollment: {
    id: string;
    status: string;
    userId: string;
    courseId: string;
    createdAt: Date;
  };
  try {
    enrollment = await db.enrollment.create({
      data: { userId: user.id, courseId: course.id },
      select: {
        id: true,
        status: true,
        userId: true,
        courseId: true,
        createdAt: true,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return Response.json({ error: "Already enrolled" }, { status: 409 });
    }
    throw err;
  }

  // Fire-and-forget — email failure must not roll back the enrollment
  resend.emails
    .send({
      from: "Lumio <hello@lumio.io>",
      to: user.email,
      subject: `You're enrolled in "${course.title}"`,
      react: EnrollmentEmail({
        name: user.name ?? user.email.split("@")[0],
        courseTitle: course.title,
        courseUrl: `${process.env.NEXT_PUBLIC_APP_URL}/courses/${courseId}`,
      }),
    })
    .catch(() => {});

  return Response.json(enrollment, { status: 201 });
}
