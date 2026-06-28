"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useRazorpay } from "@/hooks/useRazorpay";
import { toast } from "gooey-toast";
import type { RazorpayOptions } from "@/types";

interface EnrollButtonProps {
  courseId: string;
  price: number;
  currency: string;
  courseTitle: string;
  userEmail: string;
  userName: string | null;
  isEnrolled: boolean;
  firstLessonId: string | null;
  progress?: number;
}

export function EnrollButton({
  courseId,
  price,
  currency,
  courseTitle,
  userEmail,
  userName,
  isEnrolled,
  firstLessonId,
  progress = 0,
}: EnrollButtonProps) {
  const router = useRouter();
  const { loadRazorpay, isLoading: scriptLoading } = useRazorpay();
  const [loading, setLoading] = useState(false);

  function handleStartLearning() {
    if (firstLessonId) {
      router.push(`/courses/${courseId}/lessons/${firstLessonId}`);
    }
  }

  async function handleFreeEnroll() {
    setLoading(true);
    try {
      const res = await fetch(`/api/courses/${courseId}/enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const data = await res.json();
        toast.error({ title: data.error ?? "Enrollment failed" });
        return;
      }
      toast.success({ title: "Enrolled! Let's start learning." });
      router.refresh();
    } catch {
      toast.error({ title: "Something went wrong. Please try again." });
    } finally {
      setLoading(false);
    }
  }

  async function handlePaidEnroll() {
    setLoading(true);
    try {
      await loadRazorpay();

      const orderRes = await fetch(`/api/courses/${courseId}/order`, {
        method: "POST",
      });
      if (!orderRes.ok) {
        const data = await orderRes.json();
        toast.error({ title: data.error ?? "Could not initiate checkout" });
        setLoading(false);
        return;
      }
      const { orderId, amount, razorpayKeyId } = await orderRes.json();

      if (!window.Razorpay) {
        toast.error({ title: "Razorpay failed to load. Please refresh and try again." });
        setLoading(false);
        return;
      }

      const options: RazorpayOptions = {
        key: razorpayKeyId,
        order_id: orderId,
        amount: Number(amount),
        currency,
        name: "Lumio",
        description: courseTitle,
        prefill: { email: userEmail, name: userName ?? undefined },
        theme: { color: "#4F6EF7" },
        handler: async (response) => {
          const enrollRes = await fetch(`/api/courses/${courseId}/enroll`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              razorpayPaymentId: response.razorpay_payment_id,
            }),
          });
          if (!enrollRes.ok) {
            const data = await enrollRes.json();
            toast.error({ title: data.error ?? "Enrollment failed after payment" });
            return;
          }
          toast.success({ title: "Payment successful! You're enrolled." });
          router.refresh();
        },
        modal: {
          ondismiss: () => setLoading(false),
        },
      };

      const rz = new window.Razorpay(options);
      rz.open();
    } catch {
      toast.error({ title: "Something went wrong. Please try again." });
      setLoading(false);
    }
  }

  const busy = loading || scriptLoading;

  if (isEnrolled) {
    const hasLessons = !!firstLessonId;
    const label = !hasLessons
      ? "No lessons available yet"
      : progress > 0
        ? "Continue Learning"
        : "Start Learning";

    return (
      <button
        onClick={hasLessons ? handleStartLearning : undefined}
        disabled={!hasLessons}
        title={!hasLessons ? "No lessons available yet" : undefined}
        className="w-full py-3 px-6 rounded-xl font-semibold text-sm bg-(--color-brand) text-white hover:bg-(--color-brand-dark) transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {label}
      </button>
    );
  }

  return (
    <button
      onClick={price === 0 ? handleFreeEnroll : handlePaidEnroll}
      disabled={busy}
      className="w-full py-3 px-6 rounded-xl font-semibold text-sm bg-(--color-brand) text-white hover:bg-(--color-brand-dark) transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
    >
      {busy
        ? "Please wait…"
        : price === 0
          ? "Enroll for Free"
          : `Enroll · ${currency} ${price.toLocaleString("en-IN")}`}
    </button>
  );
}
