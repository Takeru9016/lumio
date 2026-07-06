import { FileQuestion, MessageCircle, Route } from "lucide-react";
import { RevealOnScroll } from "@/components/marketing/RevealOnScroll";
import { AiBadge } from "@/components/shared/AiBadge";

const FEATURES = [
  {
    icon: MessageCircle,
    title: "AI tutor",
    body: "Retrieves the exact lesson passages a question touches, then answers from that context, not a generic model guess.",
  },
  {
    icon: FileQuestion,
    title: "AI quiz generation",
    body: "Instructors generate a five-question quiz from any lesson, review it, then publish. Every question keeps the source lesson attached.",
  },
  {
    icon: Route,
    title: "AI learning path",
    body: "Looks at quiz scores and completion history, then recommends the next lessons a student actually needs.",
  },
];

export function AiSpotlight() {
  return (
    <section className="bg-ai-bg py-20 md:py-28">
      <div className="mx-auto max-w-7xl px-4 md:px-6">
        <div className="grid gap-12 md:grid-cols-2 md:items-start">
          <RevealOnScroll>
            <AiBadge label="AI in Lumio" size="md" />
            <h2 className="mt-4 max-w-md text-3xl font-semibold text-text-primary md:text-4xl">
              AI that reads your course, not the whole internet.
            </h2>
            <p className="mt-3 max-w-md text-base text-text-secondary">
              Every AI feature is grounded in the course content instructors actually wrote, and
              every AI surface carries the same purple badge so learners always know what generated
              it.
            </p>
          </RevealOnScroll>

          <div className="flex flex-col gap-6">
            {FEATURES.map((feature, i) => (
              <RevealOnScroll key={feature.title} delay={0.08 * (i + 1)} className="flex gap-4">
                <span className="flex h-10 w-10 flex-none items-center justify-center rounded-md bg-white text-ai">
                  <feature.icon size={18} />
                </span>
                <div>
                  <h3 className="text-base font-semibold text-text-primary">{feature.title}</h3>
                  <p className="mt-1 text-sm text-text-secondary">{feature.body}</p>
                </div>
              </RevealOnScroll>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
