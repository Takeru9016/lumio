import { AiSpotlight } from "@/components/marketing/AiSpotlight";
import { CapabilitiesBento } from "@/components/marketing/CapabilitiesBento";
import { FinalCta } from "@/components/marketing/FinalCta";
import { Footer } from "@/components/marketing/Footer";
import { Hero } from "@/components/marketing/Hero";
import { HowItWorks } from "@/components/marketing/HowItWorks";
import { Nav } from "@/components/marketing/Nav";
import { PricingTeaser } from "@/components/marketing/PricingTeaser";

export default function HomePage() {
  return (
    <div className="flex min-h-screen flex-col bg-surface-1">
      <Nav />
      <main className="flex-1">
        <Hero />
        <CapabilitiesBento />
        <AiSpotlight />
        <HowItWorks />
        <PricingTeaser />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}
