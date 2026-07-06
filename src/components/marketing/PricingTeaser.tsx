import Link from "next/link";

import { PlanCard } from "@/components/marketing/PlanCard";
import { RevealOnScroll } from "@/components/marketing/RevealOnScroll";
import { PLAN_CARDS } from "@/lib/marketing/plans-copy";

export function PricingTeaser() {
  return (
    <section className="mx-auto max-w-7xl px-4 py-20 md:px-6 md:py-28">
      <RevealOnScroll className="flex flex-col items-start justify-between gap-4 md:flex-row md:items-end">
        <h2 className="max-w-lg text-3xl font-semibold text-text-primary md:text-4xl">
          Start free. Grow into a plan that fits your team.
        </h2>
        <Link
          href="/pricing"
          className="text-sm font-medium text-brand transition-colors hover:text-brand-dark"
        >
          Full plan comparison
        </Link>
      </RevealOnScroll>

      <div className="mt-10 grid grid-cols-1 gap-5 md:grid-cols-4">
        {PLAN_CARDS.map((plan, i) => (
          <RevealOnScroll key={plan.name} delay={0.06 * i}>
            <PlanCard plan={plan} />
          </RevealOnScroll>
        ))}
      </div>
    </section>
  );
}
