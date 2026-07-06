import Link from "next/link";

import { RevealOnScroll } from "@/components/marketing/RevealOnScroll";

export function FinalCta() {
  return (
    <section className="mx-auto max-w-7xl px-4 py-16 md:px-6 md:py-20">
      <RevealOnScroll className="flex flex-col items-center gap-6 rounded-xl bg-brand px-6 py-14 text-center md:py-20">
        <h2 className="max-w-xl text-3xl font-semibold text-white md:text-4xl">
          Ready to run your courses better?
        </h2>
        <Link
          href="/sign-up"
          className="rounded-md bg-white px-6 py-3 text-sm font-medium text-brand transition-colors hover:bg-brand-light active:translate-y-px"
        >
          Get started free
        </Link>
        <Link href="/pricing" className="text-sm font-medium text-white/80 hover:text-white">
          or see pricing
        </Link>
      </RevealOnScroll>
    </section>
  );
}
