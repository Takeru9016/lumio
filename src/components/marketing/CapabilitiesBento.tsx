import { ClipboardCheck, Flame, MessageCircle, PlayCircle, Trophy, Users } from "lucide-react";
import { RevealOnScroll } from "@/components/marketing/RevealOnScroll";
import { AiBadge } from "@/components/shared/AiBadge";

export function CapabilitiesBento() {
  return (
    <section
      id="capabilities"
      className="mx-auto max-w-7xl scroll-mt-16 px-4 py-20 md:px-6 md:py-28"
    >
      <RevealOnScroll>
        <h2 className="max-w-lg text-3xl font-semibold text-text-primary md:text-4xl">
          One platform underneath all three roles.
        </h2>
        <p className="mt-3 max-w-lg text-base text-text-muted">
          Every capability below is shared infrastructure — students, instructors, and org admins
          each get the parts of it that matter to them.
        </p>
      </RevealOnScroll>

      <div className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-3 md:grid-rows-2">
        <RevealOnScroll
          delay={0.05}
          className="overflow-hidden rounded-lg border border-border bg-white shadow-sm md:col-span-2 md:row-span-2"
        >
          <div className="relative flex aspect-video items-center justify-center bg-linear-to-br from-surface-2 to-brand-light md:aspect-auto md:h-56">
            <span className="flex h-14 w-14 items-center justify-center rounded-md bg-white text-brand shadow-sm">
              <PlayCircle size={26} />
            </span>
          </div>
          <div className="p-5">
            <span className="flex h-9 w-9 items-center justify-center rounded-md bg-brand-light text-brand">
              <PlayCircle size={18} />
            </span>
            <h3 className="mt-3 text-lg font-semibold text-text-primary">Course engine</h3>
            <p className="mt-1 text-sm text-text-muted">
              Video lessons, drag-to-reorder sections, quizzes, and assignments, published with one
              review checklist.
            </p>
          </div>
        </RevealOnScroll>

        <RevealOnScroll
          delay={0.1}
          className="flex flex-col rounded-lg border border-ai-border bg-ai-bg p-5"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-md bg-white text-ai">
            <MessageCircle size={18} />
          </span>
          <h3 className="mt-3 text-lg font-semibold text-text-primary">AI tutor</h3>
          <p className="mt-1 text-sm text-text-secondary">
            Answers questions using the actual lesson content, not a generic model.
          </p>
          <div className="mt-3">
            <AiBadge label="Always on" />
          </div>
        </RevealOnScroll>

        <RevealOnScroll
          delay={0.15}
          className="flex flex-col rounded-lg border border-border bg-white p-5 shadow-sm"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-md bg-brand-light text-brand">
            <Flame size={18} />
          </span>
          <h3 className="mt-3 text-lg font-semibold text-text-primary">Gamification</h3>
          <p className="mt-1 text-sm text-text-muted">
            XP, streaks, and a leaderboard that keeps learners coming back without feeling like a
            game show.
          </p>
          <div className="mt-3 flex items-center gap-1.5 text-sm font-medium text-text-secondary">
            <Trophy size={14} className="text-brand" />
            <span>Weekly and all-time rankings</span>
          </div>
        </RevealOnScroll>

        <RevealOnScroll
          delay={0.2}
          className="flex flex-col justify-between gap-4 rounded-lg border border-border bg-white p-5 shadow-sm md:col-span-3 md:flex-row md:items-center"
        >
          <div>
            <span className="flex h-9 w-9 items-center justify-center rounded-md bg-brand-light text-brand">
              <Users size={18} />
            </span>
            <h3 className="mt-3 text-lg font-semibold text-text-primary">
              Org admin and compliance
            </h3>
            <p className="mt-1 max-w-md text-sm text-text-muted">
              Assign mandatory training with deadlines, track overdue members by team, and export
              completion reports.
            </p>
          </div>
          <div className="flex items-center gap-2 self-start rounded-md bg-surface-2 px-3 py-2 text-sm font-medium text-text-secondary md:self-auto">
            <ClipboardCheck size={16} className="text-brand" />
            Auto-flagged overdue tracking
          </div>
        </RevealOnScroll>
      </div>
    </section>
  );
}
