"use client";

import { Play } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import Link from "next/link";

import { AiBadge } from "@/components/shared/AiBadge";

export function Hero() {
  const reduce = useReducedMotion();

  return (
    <section className="mx-auto max-w-7xl px-4 pt-16 pb-20 md:px-6 md:pt-20 md:pb-28">
      <div className="grid items-center gap-12 md:grid-cols-2 md:gap-16">
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        >
          <h1 className="max-w-xl text-4xl font-semibold text-text-primary md:text-5xl lg:text-6xl">
            Run your courses. Let AI handle the busywork.
          </h1>
          <p className="mt-5 max-w-md text-base text-text-muted md:text-lg">
            Video lessons, adaptive quizzes, and an AI tutor that answers from your own course
            content, for teams and independent instructors.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              href="/sign-up"
              className="rounded-md bg-brand px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand-dark active:translate-y-px"
            >
              Get started free
            </Link>
            <Link
              href="/pricing"
              className="rounded-md border border-border bg-white px-5 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-surface-2"
            >
              See pricing
            </Link>
          </div>
        </motion.div>

        <motion.div
          initial={reduce ? false : { opacity: 0, y: 24, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.6, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
          className="relative"
        >
          <div className="overflow-hidden rounded-xl border border-border bg-white shadow-lg">
            <div className="relative aspect-video">
              <img
                src="https://picsum.photos/seed/lumio-systems-design/640/360"
                alt="Lesson video thumbnail"
                className="h-full w-full object-cover"
              />
              <div className="absolute inset-0 flex items-center justify-center bg-black/25">
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white/95 text-text-primary shadow-md">
                  <Play size={20} fill="currentColor" />
                </span>
              </div>
            </div>
            <div className="p-4">
              <p className="text-xs font-medium text-text-muted">Systems Design 101</p>
              <p className="mt-0.5 text-sm font-semibold text-text-primary">
                Lesson 4: Consistency models
              </p>
              <div className="mt-3 h-1.5 rounded-full bg-surface-3">
                <div className="h-full w-3/5 rounded-full bg-brand" />
              </div>
            </div>
          </div>

          <div className="absolute -bottom-8 -left-6 w-64 rounded-lg border border-ai-border bg-white p-3 shadow-lg md:-left-10">
            <AiBadge label="AI Tutor" />
            <p className="mt-2 text-xs leading-relaxed text-text-secondary">
              Based on Lesson 4, strong consistency means every read sees the latest write.
            </p>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
