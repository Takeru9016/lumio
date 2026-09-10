"use client";

import { toast } from "gooey-toast";
import { Sparkles, Trash2, Wand2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

type Difficulty = "BEGINNER" | "INTERMEDIATE" | "ADVANCED";

type LessonProposal = {
  title: string;
  objective: string;
  estimatedMinutes: number;
  contentType: "VIDEO" | "TEXT" | "QUIZ" | "ASSIGNMENT";
  supportsSkillNames: string[];
  citationIndices: number[];
};

type SectionProposal = {
  title: string;
  description: string;
  lessons: LessonProposal[];
};

type CourseProposal = {
  title: string;
  description: string;
  learningObjectives: string[];
  targetSkillNames: string[];
  estimatedDurationHours: number;
  sections: SectionProposal[];
  assessmentStrategy: string;
};

type KnowledgeItem = {
  chunkId: string;
  content: string;
  citation: { documentTitle: string; sourceId: string };
};

type Step = "define" | "review";

const inputClass =
  "w-full rounded-md border border-(--color-border) bg-white px-3 py-2 text-sm text-(--color-text-primary) placeholder:text-(--color-text-disabled) focus:outline-none focus:ring-2 focus:ring-(--color-ai) focus:border-transparent transition-all";
const labelClass = "block text-sm font-medium text-(--color-text-primary) mb-1.5";

export default function CreateAiCoursePage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("define");

  const [goal, setGoal] = useState("");
  const [audience, setAudience] = useState("");
  const [difficulty, setDifficulty] = useState<Difficulty | "">("");
  const [durationHours, setDurationHours] = useState<number | "">("");

  const [isGenerating, setIsGenerating] = useState(false);
  const [proposal, setProposal] = useState<CourseProposal | null>(null);
  const [knowledge, setKnowledge] = useState<KnowledgeItem[]>([]);
  const [isSaving, setIsSaving] = useState(false);

  async function handleGenerate() {
    if (goal.trim().length < 10) {
      toast.error({ title: "Describe the course goal in a bit more detail" });
      return;
    }
    setIsGenerating(true);
    try {
      const res = await fetch("/api/ai/course-creator/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal,
          audience: audience || undefined,
          difficulty: difficulty || undefined,
          durationHours: durationHours || undefined,
          assessmentStyle: "MCQ",
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error?.toString?.() ?? "Failed to generate curriculum");
      }
      const data = await res.json();
      setProposal(data.proposal);
      setKnowledge(data.knowledge ?? []);
      setStep("review");
    } catch (e) {
      toast.error({
        title: "AI generation failed",
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setIsGenerating(false);
    }
  }

  function updateProposal(updater: (p: CourseProposal) => CourseProposal) {
    setProposal((prev) => (prev ? updater(prev) : prev));
  }

  function removeLesson(sectionIndex: number, lessonIndex: number) {
    updateProposal((p) => ({
      ...p,
      sections: p.sections.map((s, si) =>
        si !== sectionIndex ? s : { ...s, lessons: s.lessons.filter((_, li) => li !== lessonIndex) }
      ),
    }));
  }

  async function handleCreateDraft() {
    if (!proposal) return;
    setIsSaving(true);
    try {
      const res = await fetch("/api/ai/course-creator/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: proposal.title,
          description: proposal.description,
          learningObjectives: proposal.learningObjectives,
          targetSkillIds: [],
          sections: proposal.sections
            .filter((s) => s.lessons.length > 0)
            .map((s) => ({
              title: s.title,
              description: s.description,
              lessons: s.lessons.map((l) => ({
                title: l.title,
                objective: l.objective,
                contentType: l.contentType,
              })),
            })),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error?.toString?.() ?? "Failed to create draft course");
      }
      const course = await res.json();
      toast.success({ title: "Draft course created" });
      router.push(`/courses/${course.slug}/edit`);
    } catch (e) {
      toast.error({
        title: "Could not create draft",
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <div className="flex items-center gap-2 mb-2">
        <Sparkles className="h-5 w-5 text-ai" />
        <span className="text-xs font-medium uppercase tracking-wide text-ai">
          AI Course Creator
        </span>
      </div>
      <h1 className="text-[22px] font-semibold font-heading mb-1">
        {step === "define" ? "Describe the course you want" : "Review the AI-generated proposal"}
      </h1>
      <p className="text-sm text-text-muted mb-8">
        {step === "define"
          ? "AI proposes a curriculum. You review, edit, and approve it before anything is saved."
          : "Nothing is saved yet — this is a proposal. Edit freely, then create the draft when you're happy with it."}
      </p>

      {step === "define" && (
        <div className="space-y-5">
          <div>
            <label className={labelClass}>
              Course goal <span className="text-danger">*</span>
            </label>
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={3}
              className={inputClass}
              placeholder="e.g. Create a beginner course that teaches new sales employees how to qualify B2B leads."
            />
          </div>
          <div>
            <label className={labelClass}>Intended audience</label>
            <input
              value={audience}
              onChange={(e) => setAudience(e.target.value)}
              className={inputClass}
              placeholder="e.g. New sales hires with no prior B2B experience"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Difficulty</label>
              <select
                value={difficulty}
                onChange={(e) => setDifficulty(e.target.value as Difficulty | "")}
                className={inputClass}
              >
                <option value="">Let AI decide</option>
                <option value="BEGINNER">Beginner</option>
                <option value="INTERMEDIATE">Intermediate</option>
                <option value="ADVANCED">Advanced</option>
              </select>
            </div>
            <div>
              <label className={labelClass}>Approx. duration (hours)</label>
              <input
                type="number"
                min={1}
                max={200}
                value={durationHours}
                onChange={(e) => setDurationHours(e.target.value ? Number(e.target.value) : "")}
                className={inputClass}
                placeholder="e.g. 4"
              />
            </div>
          </div>

          <div className="pt-2 flex justify-end">
            <button
              type="button"
              disabled={isGenerating}
              onClick={handleGenerate}
              className="flex items-center gap-2 bg-ai text-white rounded-md px-5 py-2 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-60"
            >
              <Wand2 className="h-4 w-4" />
              {isGenerating ? "Generating curriculum…" : "Generate curriculum"}
            </button>
          </div>
        </div>
      )}

      {step === "review" && proposal && (
        <div className="space-y-6">
          <div className="rounded-lg border border-border bg-surface-1 p-5 space-y-3">
            <div>
              <label className={labelClass}>Title</label>
              <input
                value={proposal.title}
                onChange={(e) => updateProposal((p) => ({ ...p, title: e.target.value }))}
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Description</label>
              <textarea
                value={proposal.description}
                onChange={(e) => updateProposal((p) => ({ ...p, description: e.target.value }))}
                rows={3}
                className={inputClass}
              />
            </div>
            <div>
              <p className={labelClass}>Learning objectives</p>
              <ul className="list-disc list-inside text-sm text-text-primary space-y-1">
                {proposal.learningObjectives.map((o) => (
                  <li key={o}>{o}</li>
                ))}
              </ul>
            </div>
            {proposal.targetSkillNames.length > 0 && (
              <div>
                <p className={labelClass}>AI-suggested skills</p>
                <div className="flex flex-wrap gap-2">
                  {proposal.targetSkillNames.map((name) => (
                    <span key={name} className="text-xs rounded-full bg-ai-bg text-ai px-2.5 py-1">
                      {name}
                    </span>
                  ))}
                </div>
                <p className="mt-1 text-xs text-text-muted">
                  Suggestions only — not yet linked to Skill records for this organization.
                </p>
              </div>
            )}
          </div>

          <div className="space-y-4">
            {proposal.sections.map((section, si) => (
              <div
                key={`${section.title}-${si}`}
                className="rounded-lg border border-border bg-surface-1 p-5"
              >
                <input
                  value={section.title}
                  onChange={(e) =>
                    updateProposal((p) => ({
                      ...p,
                      sections: p.sections.map((s, i) =>
                        i === si ? { ...s, title: e.target.value } : s
                      ),
                    }))
                  }
                  className="w-full text-sm font-semibold bg-transparent focus:outline-none mb-3"
                />
                <div className="space-y-2">
                  {section.lessons.map((lesson, li) => (
                    <div
                      key={`${lesson.title}-${li}`}
                      className="flex items-start justify-between gap-3 rounded-md bg-surface-2 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{lesson.title}</p>
                        <p className="text-xs text-text-muted">
                          {lesson.contentType} · {lesson.estimatedMinutes} min
                          {lesson.citationIndices.length > 0 && (
                            <>
                              {" "}
                              · grounded in{" "}
                              {lesson.citationIndices
                                .map((i) => knowledge[i]?.citation.documentTitle)
                                .filter(Boolean)
                                .join(", ")}
                            </>
                          )}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeLesson(si, li)}
                        className="shrink-0 text-text-muted hover:text-danger transition-colors"
                        aria-label={`Remove lesson ${lesson.title}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="flex justify-between pt-2">
            <button
              type="button"
              onClick={() => setStep("define")}
              className="text-sm text-text-muted hover:text-text-primary transition-colors"
            >
              ← Start over
            </button>
            <button
              type="button"
              disabled={isSaving}
              onClick={handleCreateDraft}
              className="bg-brand text-white rounded-md px-5 py-2 text-sm font-medium hover:bg-brand-dark transition-colors disabled:opacity-60"
            >
              {isSaving ? "Creating draft…" : "Create draft course"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
