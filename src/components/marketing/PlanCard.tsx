import { Check } from "lucide-react";
import Link from "next/link";

export type PlanCardData = {
  name: string;
  price: string;
  priceNote?: string;
  description: string;
  features: string[];
  cta: { label: string; href: string };
  highlighted?: boolean;
};

export function PlanCard({ plan }: { plan: PlanCardData }) {
  return (
    <div
      className={`flex flex-col rounded-lg border p-6 ${
        plan.highlighted
          ? "border-brand bg-white shadow-lg md:-mt-3 md:mb-3 md:py-8"
          : "border-border bg-white shadow-sm"
      }`}
    >
      {plan.highlighted && (
        <span className="mb-3 inline-flex w-fit items-center rounded-full bg-brand-light px-2.5 py-0.5 text-xs font-medium text-brand">
          Most popular
        </span>
      )}
      <h3 className="text-lg font-semibold text-text-primary">{plan.name}</h3>
      <p className="mt-1 text-sm text-text-muted">{plan.description}</p>

      <div className="mt-4 flex items-baseline gap-1">
        <span className="text-3xl font-semibold text-text-primary">{plan.price}</span>
        {plan.priceNote && <span className="text-sm text-text-muted">{plan.priceNote}</span>}
      </div>

      <Link
        href={plan.cta.href}
        className={`mt-6 rounded-md px-4 py-2.5 text-center text-sm font-medium transition-colors ${
          plan.highlighted
            ? "bg-brand text-white hover:bg-brand-dark"
            : "border border-border bg-white text-text-primary hover:bg-surface-2"
        }`}
      >
        {plan.cta.label}
      </Link>

      <ul className="mt-6 flex flex-col gap-2.5">
        {plan.features.map((feature) => (
          <li key={feature} className="flex items-start gap-2 text-sm text-text-secondary">
            <Check size={16} className="mt-0.5 flex-none text-brand" />
            <span>{feature}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
