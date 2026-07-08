import { PlanCard } from "@/components/marketing/PlanCard";
import { RevealOnScroll } from "@/components/marketing/RevealOnScroll";
import { PLAN_CARDS } from "@/lib/marketing/plans-copy";

const COMPARISON_ROWS: { label: string; values: [string, string, string, string] }[] = [
  { label: "Courses", values: ["1", "Up to 10", "Unlimited", "Unlimited"] },
  { label: "AI calls per month", values: ["0", "50", "200", "Unlimited"] },
  { label: "Team seats", values: ["0", "Up to 10", "Up to 100", "Custom"] },
  { label: "Custom domain", values: ["No", "No", "Yes", "Yes"] },
  { label: "SAML SSO", values: ["No", "No", "No", "Yes"] },
];

export function PricingSection() {
  return (
    <section id="pricing" className="mx-auto max-w-7xl scroll-mt-16 px-4 py-20 md:px-6 md:py-28">
      <RevealOnScroll className="mx-auto max-w-2xl text-center">
        <h2 className="text-3xl font-semibold text-text-primary md:text-4xl">
          Start free. Grow into a plan that fits your team.
        </h2>
        <p className="mt-3 text-base text-text-muted">
          One course, free, forever. Move to a paid plan when you need more seats, AI calls, or
          courses.
        </p>
      </RevealOnScroll>

      <div className="mt-10 grid grid-cols-1 gap-5 md:grid-cols-4">
        {PLAN_CARDS.map((plan, i) => (
          <RevealOnScroll key={plan.name} delay={0.06 * i}>
            <PlanCard plan={plan} />
          </RevealOnScroll>
        ))}
      </div>

      <RevealOnScroll delay={0.1} className="mt-12 overflow-x-auto rounded-lg border border-border">
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
  );
}
