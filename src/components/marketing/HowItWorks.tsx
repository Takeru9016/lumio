import { Building2, GraduationCap, PenSquare, TrendingUp } from "lucide-react";

import { RevealOnScroll } from "@/components/marketing/RevealOnScroll";

const STEPS = [
  {
    icon: Building2,
    title: "Org admin sets up",
    body: "Invite teams, assign mandatory training, and set deadlines, all from one dashboard.",
  },
  {
    icon: PenSquare,
    title: "Instructor builds",
    body: "Structure video lessons, add quizzes and assignments, and publish with one review checklist.",
  },
  {
    icon: GraduationCap,
    title: "Student learns",
    body: "Work through lessons at your own pace, with an AI tutor grounded in the course content.",
  },
  {
    icon: TrendingUp,
    title: "Everyone sees progress",
    body: "Completion and quiz scores roll in live, with overdue members auto-flagged by team.",
  },
];

export function HowItWorks() {
  return (
    <section className="mx-auto max-w-7xl px-4 py-20 md:px-6 md:py-28">
      <RevealOnScroll>
        <h2 className="max-w-lg text-3xl font-semibold text-text-primary md:text-4xl">
          From setup to certified, in one loop.
        </h2>
      </RevealOnScroll>

      <div className="relative mt-14 grid gap-10 md:grid-cols-4 md:gap-8">
        <div
          className="absolute top-6 left-0 hidden h-px w-full bg-border md:block"
          aria-hidden="true"
        />
        {STEPS.map((step, i) => (
          <RevealOnScroll key={step.title} delay={0.1 * i} className="relative">
            <span className="relative z-10 flex h-12 w-12 items-center justify-center rounded-full border border-border bg-white text-brand shadow-sm">
              <step.icon size={20} />
            </span>
            <h3 className="mt-4 text-base font-semibold text-text-primary">{step.title}</h3>
            <p className="mt-1 max-w-xs text-sm text-text-muted">{step.body}</p>
          </RevealOnScroll>
        ))}
      </div>
    </section>
  );
}
