import { BookOpen, TrendingUp, UserPlus } from "lucide-react";

import { RevealOnScroll } from "@/components/marketing/RevealOnScroll";

const STEPS = [
  {
    icon: BookOpen,
    title: "Build your course",
    body: "Upload video lessons, structure sections, and add quizzes and assignments.",
  },
  {
    icon: UserPlus,
    title: "Invite your team",
    body: "Add students or org members, assign mandatory training, and set deadlines.",
  },
  {
    icon: TrendingUp,
    title: "Track progress with AI",
    body: "Watch completion and quiz scores roll in, with AI flagging who needs a nudge.",
  },
];

export function HowItWorks() {
  return (
    <section className="mx-auto max-w-7xl px-4 py-20 md:px-6 md:py-28">
      <RevealOnScroll>
        <h2 className="max-w-lg text-3xl font-semibold text-text-primary md:text-4xl">
          From first lesson to full rollout.
        </h2>
      </RevealOnScroll>

      <div className="relative mt-14 grid gap-10 md:grid-cols-3 md:gap-8">
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
