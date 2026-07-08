import type { Metadata } from "next";

import { AiSpotlight } from "@/components/marketing/AiSpotlight";
import { AudienceShowcase } from "@/components/marketing/AudienceShowcase";
import { CapabilitiesBento } from "@/components/marketing/CapabilitiesBento";
import { FaqSection } from "@/components/marketing/FaqSection";
import { FinalCta } from "@/components/marketing/FinalCta";
import { Footer } from "@/components/marketing/Footer";
import { Hero } from "@/components/marketing/Hero";
import { HowItWorks } from "@/components/marketing/HowItWorks";
import { Nav } from "@/components/marketing/Nav";
import { PricingSection } from "@/components/marketing/PricingSection";
import { TrustSection } from "@/components/marketing/TrustSection";

export const metadata: Metadata = {
  title: "Lumio - AI-integrated learning for students, instructors, and organizations",
  description:
    "Lumio is one learning platform built for three roles: students learn with an AI tutor grounded in the course content, instructors build and grade in less time, and org admins track training completion across every team.",
};

export default function HomePage() {
  return (
    <div className="flex min-h-screen flex-col bg-surface-1">
      <Nav />
      <main className="flex-1">
        <Hero />
        <AudienceShowcase />
        <CapabilitiesBento />
        <AiSpotlight />
        <HowItWorks />
        <TrustSection />
        <PricingSection />
        <FaqSection />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}
