"use client";

import { ChevronDown } from "lucide-react";
import { useState } from "react";

import { RevealOnScroll } from "@/components/marketing/RevealOnScroll";

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

export function FaqSection() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <section id="faq" className="mx-auto max-w-3xl scroll-mt-16 px-4 py-20 md:px-6 md:py-28">
      <RevealOnScroll>
        <h2 className="text-3xl font-semibold text-text-primary md:text-4xl">
          Frequently asked questions
        </h2>
      </RevealOnScroll>

      <RevealOnScroll delay={0.06} className="mt-10 rounded-lg border border-border">
        <div className="divide-y divide-border">
          {FAQ.map((item, i) => {
            const open = openIndex === i;
            return (
              <div key={item.question}>
                <button
                  type="button"
                  onClick={() => setOpenIndex(open ? null : i)}
                  className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left"
                  aria-expanded={open}
                >
                  <span className="text-sm font-semibold text-text-primary">{item.question}</span>
                  <ChevronDown
                    size={18}
                    className={`flex-none text-text-muted transition-transform duration-200 ${
                      open ? "rotate-180" : ""
                    }`}
                  />
                </button>
                <div
                  className={`grid transition-all duration-300 ease-out ${
                    open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
                  }`}
                >
                  <div className="overflow-hidden">
                    <p className="px-5 pb-4 text-sm text-text-muted">{item.answer}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </RevealOnScroll>
    </section>
  );
}
