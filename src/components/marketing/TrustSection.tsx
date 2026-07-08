import { Layers, ShieldCheck, Sparkles } from "lucide-react";

import { RevealOnScroll } from "@/components/marketing/RevealOnScroll";

const PILLARS = [
  {
    icon: ShieldCheck,
    title: "Role-based, by design",
    body: "Students, instructors, and org admins each see only their own data. Permissions are enforced at the data layer, not just hidden in the UI.",
  },
  {
    icon: Sparkles,
    title: "AI that shows its work",
    body: "Every AI-generated answer, quiz, or recommendation carries a visible badge and traces back to the lesson it came from. Nothing silent, nothing generic.",
  },
  {
    icon: Layers,
    title: "Built to scale with your org",
    body: "Multi-tenant from day one: per-org data isolation, custom branding, and SAML SSO are core to the platform, not bolted on later.",
  },
];

export function TrustSection() {
  return (
    <section className="border-t border-border bg-surface-2 py-20 md:py-28">
      <div className="mx-auto max-w-7xl px-4 md:px-6">
        <RevealOnScroll className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-semibold text-text-primary md:text-4xl">
            Why teams trust Lumio with their training.
          </h2>
        </RevealOnScroll>

        <div className="mt-12 grid grid-cols-1 gap-8 md:grid-cols-3">
          {PILLARS.map((pillar, i) => (
            <RevealOnScroll key={pillar.title} delay={0.08 * i} className="flex flex-col">
              <span className="flex h-11 w-11 items-center justify-center rounded-md bg-white text-brand shadow-sm">
                <pillar.icon size={20} />
              </span>
              <h3 className="mt-4 text-base font-semibold text-text-primary">{pillar.title}</h3>
              <p className="mt-1.5 text-sm text-text-muted">{pillar.body}</p>
            </RevealOnScroll>
          ))}
        </div>
      </div>
    </section>
  );
}
