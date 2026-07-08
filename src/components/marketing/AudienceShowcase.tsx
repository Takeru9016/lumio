import {
  Building2,
  Check,
  ClipboardCheck,
  GraduationCap,
  MessageCircle,
  PenSquare,
  Shield,
  Sparkles,
  Trophy,
  Users,
} from "lucide-react";
import Link from "next/link";

import { RevealOnScroll } from "@/components/marketing/RevealOnScroll";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Audience = {
  value: string;
  tabLabel: string;
  tabIcon: typeof GraduationCap;
  eyebrow: string;
  headline: string;
  body: string;
  points: { icon: typeof GraduationCap; label: string }[];
  cta: { label: string; href: string };
  accent: "brand" | "ai";
};

const AUDIENCES: Audience[] = [
  {
    value: "student",
    tabLabel: "Students",
    tabIcon: GraduationCap,
    eyebrow: "For students",
    headline: "Learn faster, get unstuck less.",
    body: "Work through video lessons at your own pace, and ask the AI tutor whenever a concept doesn't click — it answers from the lesson you're actually on.",
    points: [
      { icon: MessageCircle, label: "AI tutor grounded in your course content, not the open web" },
      { icon: Check, label: "Auto-generated quizzes that check understanding as you go" },
      { icon: Trophy, label: "XP, streaks, and a leaderboard that keeps you coming back" },
    ],
    cta: { label: "Start learning free", href: "/sign-up" },
    accent: "ai",
  },
  {
    value: "instructor",
    tabLabel: "Instructors",
    tabIcon: PenSquare,
    eyebrow: "For instructors",
    headline: "Build a course once. Let AI handle the busywork.",
    body: "Structure lessons with a drag-to-reorder builder, generate a quiz from any lesson in one click, and see exactly which students are stuck, before they ask.",
    points: [
      { icon: PenSquare, label: "Drag-to-reorder builder for video, quizzes, and assignments" },
      {
        icon: Sparkles,
        label: "AI-generated quizzes from any lesson, you review before publishing",
      },
      { icon: Users, label: "Per-student analytics: completion, quiz scores, and drop-off points" },
    ],
    cta: { label: "Start teaching", href: "/sign-up" },
    accent: "brand",
  },
  {
    value: "org",
    tabLabel: "Organizations",
    tabIcon: Building2,
    eyebrow: "For organizations",
    headline: "Roll out training across every team, and prove it happened.",
    body: "Assign mandatory training with deadlines, get overdue members flagged automatically by team, and export a completion report the second an audit asks for one.",
    points: [
      {
        icon: ClipboardCheck,
        label: "Mandatory training with deadlines and auto-flagged overdue members",
      },
      {
        icon: Shield,
        label: "Role-based access across every team, so admins only see what's theirs",
      },
      { icon: Building2, label: "Custom branding, seat management, and SAML SSO on Enterprise" },
    ],
    cta: { label: "Talk to sales", href: "mailto:sales@lumio.io" },
    accent: "brand",
  },
];

export function AudienceShowcase() {
  return (
    <section id="solutions" className="mx-auto max-w-7xl scroll-mt-16 px-4 py-20 md:px-6 md:py-28">
      <RevealOnScroll className="mx-auto max-w-2xl text-center">
        <h2 className="text-3xl font-semibold text-text-primary md:text-4xl">
          Built for every seat at the table.
        </h2>
        <p className="mt-3 text-base text-text-muted">
          Lumio is one app with three views: students learn in it, instructors teach in it, and org
          admins run their whole training program from it.
        </p>
      </RevealOnScroll>

      <RevealOnScroll delay={0.08} className="mt-10">
        <Tabs defaultValue="student" className="w-full">
          <TabsList className="mx-auto flex h-auto w-fit flex-wrap justify-center gap-1 p-1.5">
            {AUDIENCES.map((audience) => (
              <TabsTrigger
                key={audience.value}
                value={audience.value}
                className="gap-1.5 px-4 py-2"
              >
                <audience.tabIcon size={15} />
                {audience.tabLabel}
              </TabsTrigger>
            ))}
          </TabsList>

          {AUDIENCES.map((audience) => (
            <TabsContent key={audience.value} value={audience.value} className="mt-8">
              <div className="grid gap-10 rounded-xl border border-border bg-white p-6 shadow-sm md:grid-cols-2 md:gap-14 md:p-10">
                <div>
                  <span
                    className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${
                      audience.accent === "ai" ? "bg-ai-bg text-ai" : "bg-brand-light text-brand"
                    }`}
                  >
                    {audience.eyebrow}
                  </span>
                  <h3 className="mt-4 text-2xl font-semibold text-text-primary md:text-3xl">
                    {audience.headline}
                  </h3>
                  <p className="mt-3 text-base text-text-muted">{audience.body}</p>
                  <Link
                    href={audience.cta.href}
                    className="mt-6 inline-flex rounded-md bg-brand px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand-dark active:translate-y-px"
                  >
                    {audience.cta.label}
                  </Link>
                </div>

                <div className="flex flex-col gap-4">
                  {audience.points.map((point) => (
                    <div key={point.label} className="flex items-start gap-3">
                      <span
                        className={`flex h-9 w-9 flex-none items-center justify-center rounded-md ${
                          audience.accent === "ai"
                            ? "bg-ai-bg text-ai"
                            : "bg-brand-light text-brand"
                        }`}
                      >
                        <point.icon size={17} />
                      </span>
                      <p className="mt-1.5 text-sm text-text-secondary">{point.label}</p>
                    </div>
                  ))}
                </div>
              </div>
            </TabsContent>
          ))}
        </Tabs>
      </RevealOnScroll>
    </section>
  );
}
