import type { Metadata } from "next";

import { Footer } from "@/components/marketing/Footer";
import { Nav } from "@/components/marketing/Nav";
import { PlanCard } from "@/components/marketing/PlanCard";
import { RevealOnScroll } from "@/components/marketing/RevealOnScroll";
import { PLAN_CARDS } from "@/lib/marketing/plans-copy";

export const metadata: Metadata = {
  title: "Pricing - Lumio",
  description: "Compare Lumio's Free, Starter, Pro, and Enterprise plans.",
};

const COMPARISON_ROWS: { label: string; values: [string, string, string, string] }[] = [
  { label: "Courses", values: ["1", "Up to 10", "Unlimited", "Unlimited"] },
  { label: "AI calls per month", values: ["0", "50", "200", "Unlimited"] },
  { label: "Team seats", values: ["0", "Up to 10", "Up to 100", "Custom"] },
  { label: "Custom domain", values: ["No", "No", "Yes", "Yes"] },
  { label: "SAML SSO", values: ["No", "No", "No", "Yes"] },
];

const FAQ = [
  {
    question: "What counts as an AI call?",
    answer:
      "Each AI tutor message, quiz generation, lesson summary, or learning-path request counts as one call against your plan's monthly quota.",
  },
  {
    question: "Can I switch plans later?",
    answer:
      "Yes. Org admins can upgrade or downgrade from Settings, and the new plan applies at the next billing cycle.",
  },
  {
    question: "Do unused AI calls roll over?",
    answer: "No, the quota resets to zero at the start of each billing cycle.",
  },
  {
    question: "Is there a free trial for paid plans?",
    answer:
      "The Free plan works as an ongoing trial with a single course. Talk to sales for a scoped Starter or Pro trial.",
  },
];

export default function PricingPage() {
  return (
    <div className="flex min-h-screen flex-col bg-surface-1">
      <Nav />
      <main className="flex-1">
        <section className="mx-auto max-w-7xl px-4 pt-16 pb-4 text-center md:px-6 md:pt-20">
          <RevealOnScroll>
            <h1 className="mx-auto max-w-2xl text-4xl font-semibold text-text-primary md:text-5xl">
              Simple plans that grow with your team.
            </h1>
            <p className="mx-auto mt-4 max-w-md text-base text-text-muted">
              Start free with one course. Move to a paid plan when you need more seats, AI calls, or
              courses.
            </p>
          </RevealOnScroll>
        </section>

        <section className="mx-auto max-w-7xl px-4 py-14 md:px-6">
          <div className="grid grid-cols-1 gap-5 md:grid-cols-4">
            {PLAN_CARDS.map((plan, i) => (
              <RevealOnScroll key={plan.name} delay={0.06 * i}>
                <PlanCard plan={plan} />
              </RevealOnScroll>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-5xl px-4 py-14 md:px-6">
          <RevealOnScroll>
            <h2 className="text-2xl font-semibold text-text-primary md:text-3xl">
              Compare plans in detail
            </h2>
          </RevealOnScroll>

          <RevealOnScroll
            delay={0.05}
            className="mt-8 overflow-x-auto rounded-lg border border-border"
          >
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-2">
                  <th className="px-4 py-3 font-medium text-text-muted">Feature</th>
                  {PLAN_CARDS.map((plan) => (
                    <th key={plan.name} className="px-4 py-3 font-medium text-text-primary">
                      {plan.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {COMPARISON_ROWS.map((row) => (
                  <tr key={row.label} className="border-b border-border last:border-b-0">
                    <td className="px-4 py-3 text-text-secondary">{row.label}</td>
                    {row.values.map((value, i) => (
                      <td key={PLAN_CARDS[i].name} className="px-4 py-3 text-text-primary">
                        {value}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </RevealOnScroll>
        </section>

        <section className="mx-auto max-w-3xl px-4 py-14 md:px-6 md:py-20">
          <RevealOnScroll>
            <h2 className="text-2xl font-semibold text-text-primary md:text-3xl">
              Frequently asked questions
            </h2>
          </RevealOnScroll>

          <div className="mt-8 divide-y divide-border">
            {FAQ.map((item, i) => (
              <RevealOnScroll key={item.question} delay={0.04 * i} className="py-5">
                <h3 className="text-base font-semibold text-text-primary">{item.question}</h3>
                <p className="mt-1.5 text-sm text-text-muted">{item.answer}</p>
              </RevealOnScroll>
            ))}
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
