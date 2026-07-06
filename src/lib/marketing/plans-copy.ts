import type { PlanCardData } from "@/components/marketing/PlanCard";

export const PLAN_CARDS: PlanCardData[] = [
  {
    name: "Free",
    price: "$0",
    priceNote: "forever",
    description: "Try Lumio with a single course.",
    features: ["1 course", "0 AI calls per month", "Personal use, no team seats"],
    cta: { label: "Get started free", href: "/sign-up" },
  },
  {
    name: "Starter",
    price: "Contact sales",
    description: "For small teams getting structured training off the ground.",
    features: ["Up to 10 courses", "50 AI calls per month", "Up to 10 seats"],
    cta: { label: "Contact sales", href: "mailto:sales@lumio.io" },
  },
  {
    name: "Pro",
    price: "Contact sales",
    description: "For growing orgs that want AI grading and tutoring at scale.",
    features: ["Unlimited courses", "200 AI calls per month", "Up to 100 seats", "Custom domain"],
    cta: { label: "Contact sales", href: "mailto:sales@lumio.io" },
    highlighted: true,
  },
  {
    name: "Enterprise",
    price: "Contact sales",
    description: "For large orgs that need SSO and a custom seat count.",
    features: ["Unlimited courses and AI calls", "Custom seat count", "SAML SSO", "Custom domain"],
    cta: { label: "Contact sales", href: "mailto:sales@lumio.io" },
  },
];
