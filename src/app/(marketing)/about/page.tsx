import { BookOpen, Building2, GraduationCap, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";

import { FinalCta } from "@/components/marketing/FinalCta";
import { Footer } from "@/components/marketing/Footer";
import { Nav } from "@/components/marketing/Nav";
import { RevealOnScroll } from "@/components/marketing/RevealOnScroll";

export const metadata: Metadata = {
  title: "About - Lumio",
  description: "Why we built Lumio, and who it's built for.",
};

const ROLES = [
  {
    icon: GraduationCap,
    title: "Students",
    body: "Learn with video lessons, quizzes, and an AI tutor that answers from the actual course content, not a generic model.",
  },
  {
    icon: BookOpen,
    title: "Instructors",
    body: "Build courses with a drag-to-reorder builder, grade assignments, and see which lessons students actually finish.",
  },
  {
    icon: Building2,
    title: "Org admins",
    body: "Assign mandatory training with deadlines, track overdue members by team, and export completion reports.",
  },
  {
    icon: ShieldCheck,
    title: "Platform admins",
    body: "Oversee every organization on Lumio from one place: plans, seats, and account status.",
  },
];

export default function AboutPage() {
  return (
    <div className="flex min-h-screen flex-col bg-surface-1">
      <Nav />
      <main className="flex-1">
        <section className="mx-auto max-w-3xl px-4 pt-16 pb-10 md:px-6 md:pt-20">
          <RevealOnScroll>
            <h1 className="text-4xl font-semibold text-text-primary md:text-5xl">
              Learning software shouldn't feel like busywork.
            </h1>
            <p className="mt-4 text-base text-text-muted md:text-lg">
              Lumio is a course platform built around one idea: AI should do the repetitive parts of
              teaching and learning, so instructors spend less time grading and students spend less
              time stuck.
            </p>
          </RevealOnScroll>
        </section>

        <section className="mx-auto max-w-3xl px-4 py-10 md:px-6">
          <RevealOnScroll>
            <h2 className="text-2xl font-semibold text-text-primary md:text-3xl">
              Built for four roles, in one app
            </h2>
          </RevealOnScroll>

          <div className="mt-8 flex flex-col divide-y divide-border">
            {ROLES.map((role, i) => (
              <RevealOnScroll
                key={role.title}
                delay={0.06 * i}
                className="flex gap-4 py-5 first:pt-0"
              >
                <span className="flex h-10 w-10 flex-none items-center justify-center rounded-md bg-brand-light text-brand">
                  <role.icon size={18} />
                </span>
                <div>
                  <h3 className="text-base font-semibold text-text-primary">{role.title}</h3>
                  <p className="mt-1 text-sm text-text-muted">{role.body}</p>
                </div>
              </RevealOnScroll>
            ))}
          </div>
        </section>

        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}
