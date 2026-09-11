"use client";

import { toast } from "gooey-toast";
import { Sparkles, Trash2, Wand2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

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

type KnowledgeDocumentOption = {
  id: string;
  title: string;
  sourceId: string;
  sourceName: string;
};

type SkillOption = {
  id: string;
  name: string;
  categoryId: string | null;
  categoryName: string | null;
};

type QuizQuestionState = {
  uiId: string;
  question: string;
  options: Array<{ id: string; text: string }>;
  correctAnswer: string;
  explanation?: string;
};

type LessonReviewState = {
  textContent?: string;
  knowledgeDocumentId?: string;
  assessment?: { title: string; passingScore: number; questions: QuizQuestionState[] };
  contentStatus: "idle" | "loading" | "error";
  contentError?: string;
  quizStatus: "idle" | "loading" | "error";
  quizError?: string;
};

// keyed by `${sectionIndex}-${lessonIndex}` — stable for the lifetime of one
// review session since section/lesson arrays are only ever filtered, never reordered.
type ReviewState = Record<string, LessonReviewState>;

type Step = "define" | "review";

const inputClass =
  "w-full rounded-md border border-(--color-border) bg-white px-3 py-2 text-sm text-(--color-text-primary) placeholder:text-(--color-text-disabled) focus:outline-none focus:ring-2 focus:ring-(--color-ai) focus:border-transparent transition-all";
const labelClass = "block text-sm font-medium text-(--color-text-primary) mb-1.5";

function lessonKey(sectionIndex: number, lessonIndex: number): string {
  return `${sectionIndex}-${lessonIndex}`;
}

export default function CreateAiCoursePage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("define");

  const [goal, setGoal] = useState("");
  const [audience, setAudience] = useState("");
  const [difficulty, setDifficulty] = useState<Difficulty | "">("");
  const [durationHours, setDurationHours] = useState<number | "">("");

  const [knowledgeOptions, setKnowledgeOptions] = useState<KnowledgeDocumentOption[]>([]);
  const [skillOptions, setSkillOptions] = useState<SkillOption[]>([]);
  const [selectedKnowledgeIds, setSelectedKnowledgeIds] = useState<string[]>([]);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);

  const [isGenerating, setIsGenerating] = useState(false);
  const [proposal, setProposal] = useState<CourseProposal | null>(null);
  const [knowledge, setKnowledge] = useState<KnowledgeItem[]>([]);
  const [review, setReview] = useState<ReviewState>({});
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    fetch("/api/knowledge/documents")
      .then((res) => (res.ok ? res.json() : { documents: [] }))
      .then((data) => setKnowledgeOptions(data.documents ?? []))
      .catch(() => setKnowledgeOptions([]));
    fetch("/api/skills")
      .then((res) => (res.ok ? res.json() : { skills: [] }))
      .then((data) => setSkillOptions(data.skills ?? []))
      .catch(() => setSkillOptions([]));
  }, []);

  function toggleKnowledgeId(id: string) {
    setSelectedKnowledgeIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  function toggleSkillId(id: string) {
    setSelectedSkillIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

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
          knowledgeDocumentIds: selectedKnowledgeIds.length > 0 ? selectedKnowledgeIds : undefined,
          targetSkillIds: selectedSkillIds.length > 0 ? selectedSkillIds : undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error?.toString?.() ?? "Failed to generate curriculum");
      }
      const data = await res.json();
      setProposal(data.proposal);
      setKnowledge(data.knowledge ?? []);
      setReview({});
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

  function updateLessonReview(key: string, patch: Partial<LessonReviewState>) {
    setReview((prev) => {
      const base: LessonReviewState = prev[key] ?? { contentStatus: "idle", quizStatus: "idle" };
      return { ...prev, [key]: { ...base, ...patch } };
    });
  }

  function removeLesson(sectionIndex: number, lessonIndex: number) {
    updateProposal((p) => ({
      ...p,
      sections: p.sections.map((s, si) =>
        si !== sectionIndex ? s : { ...s, lessons: s.lessons.filter((_, li) => li !== lessonIndex) }
      ),
    }));
    setReview((prev) => {
      const next = { ...prev };
      delete next[lessonKey(sectionIndex, lessonIndex)];
      return next;
    });
  }

  async function generateLessonContent(sectionIndex: number, lessonIndex: number) {
    if (!proposal) return;
    const lesson = proposal.sections[sectionIndex].lessons[lessonIndex];
    const key = lessonKey(sectionIndex, lessonIndex);
    updateLessonReview(key, { contentStatus: "loading", contentError: undefined });
    try {
      const res = await fetch("/api/ai/course-creator/content", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          courseGoal: proposal.title,
          lessonTitle: lesson.title,
          lessonObjective: lesson.objective,
          knowledgeDocumentIds: selectedKnowledgeIds.length > 0 ? selectedKnowledgeIds : undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error?.toString?.() ?? "Failed to generate content");
      }
      const data = await res.json();
      updateLessonReview(key, {
        contentStatus: "idle",
        textContent: data.html ?? "",
      });
    } catch (e) {
      updateLessonReview(key, {
        contentStatus: "error",
        contentError: e instanceof Error ? e.message : "Failed to generate content",
      });
    }
  }

  async function generateLessonQuiz(sectionIndex: number, lessonIndex: number) {
    if (!proposal) return;
    const lesson = proposal.sections[sectionIndex].lessons[lessonIndex];
    const key = lessonKey(sectionIndex, lessonIndex);
    updateLessonReview(key, { quizStatus: "loading", quizError: undefined });
    try {
      const res = await fetch("/api/ai/course-creator/assessment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lessonTitle: lesson.title,
          lessonContext: lesson.objective,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error?.toString?.() ?? "Failed to generate quiz");
      }
      const data = await res.json();
      const questions: QuizQuestionState[] = (data.questions ?? []).map(
        (q: Omit<QuizQuestionState, "uiId">, i: number) => ({
          ...q,
          uiId: `${key}-${i}-${crypto.randomUUID()}`,
        })
      );
      updateLessonReview(key, {
        quizStatus: "idle",
        assessment: { title: "Quiz", passingScore: 70, questions },
      });
    } catch (e) {
      updateLessonReview(key, {
        quizStatus: "error",
        quizError: e instanceof Error ? e.message : "Failed to generate quiz",
      });
    }
  }

  function updateQuestionText(
    sectionIndex: number,
    lessonIndex: number,
    qIndex: number,
    text: string
  ) {
    const key = lessonKey(sectionIndex, lessonIndex);
    setReview((prev) => {
      const current = prev[key];
      if (!current?.assessment) return prev;
      const questions = current.assessment.questions.map((q, i) =>
        i === qIndex ? { ...q, question: text } : q
      );
      return { ...prev, [key]: { ...current, assessment: { ...current.assessment, questions } } };
    });
  }

  function updateOptionText(
    sectionIndex: number,
    lessonIndex: number,
    qIndex: number,
    optionIndex: number,
    text: string
  ) {
    const key = lessonKey(sectionIndex, lessonIndex);
    setReview((prev) => {
      const current = prev[key];
      if (!current?.assessment) return prev;
      const questions = current.assessment.questions.map((q, i) => {
        if (i !== qIndex) return q;
        const options = q.options.map((o, oi) => (oi === optionIndex ? { ...o, text } : o));
        return { ...q, options };
      });
      return { ...prev, [key]: { ...current, assessment: { ...current.assessment, questions } } };
    });
  }

  function updateCorrectAnswer(
    sectionIndex: number,
    lessonIndex: number,
    qIndex: number,
    optionId: string
  ) {
    const key = lessonKey(sectionIndex, lessonIndex);
    setReview((prev) => {
      const current = prev[key];
      if (!current?.assessment) return prev;
      const questions = current.assessment.questions.map((q, i) =>
        i === qIndex ? { ...q, correctAnswer: optionId } : q
      );
      return { ...prev, [key]: { ...current, assessment: { ...current.assessment, questions } } };
    });
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
          targetSkillIds: selectedSkillIds,
          sections: proposal.sections
            .filter((s) => s.lessons.length > 0)
            .map((s, si) => ({
              title: s.title,
              description: s.description,
              lessons: s.lessons.map((l, li) => {
                const lessonState = review[lessonKey(si, li)];
                return {
                  title: l.title,
                  objective: l.objective,
                  contentType: l.contentType,
                  ...(lessonState?.textContent ? { textContent: lessonState.textContent } : {}),
                  ...(lessonState?.knowledgeDocumentId
                    ? { knowledgeDocumentId: lessonState.knowledgeDocumentId }
                    : {}),
                  ...(lessonState?.assessment && lessonState.assessment.questions.length > 0
                    ? {
                        assessment: {
                          ...lessonState.assessment,
                          questions: lessonState.assessment.questions.map(
                            ({ uiId: _uiId, ...q }) => q
                          ),
                        },
                      }
                    : {}),
                };
              }),
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

          <div>
            <label className={labelClass}>Knowledge documents (optional)</label>
            <p className="text-xs text-text-muted mb-2">
              Ground the curriculum in your organization's existing knowledge.
            </p>
            {knowledgeOptions.length === 0 ? (
              <p className="text-xs text-text-muted">No knowledge documents available yet.</p>
            ) : (
              <div className="border border-border rounded-md divide-y divide-border max-h-48 overflow-y-auto">
                {knowledgeOptions.map((doc) => (
                  <label
                    key={doc.id}
                    className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-surface-2"
                  >
                    <input
                      type="checkbox"
                      checked={selectedKnowledgeIds.includes(doc.id)}
                      onChange={() => toggleKnowledgeId(doc.id)}
                    />
                    <span className="truncate">{doc.title}</span>
                    <span className="text-xs text-text-muted shrink-0 ml-auto">
                      {doc.sourceName}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className={labelClass}>Target skills (optional)</label>
            <p className="text-xs text-text-muted mb-2">
              Selected skills are linked to the saved course and steer the curriculum.
            </p>
            {skillOptions.length === 0 ? (
              <p className="text-xs text-text-muted">No skills configured yet.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {skillOptions.map((skill) => {
                  const selected = selectedSkillIds.includes(skill.id);
                  return (
                    <button
                      key={skill.id}
                      type="button"
                      onClick={() => toggleSkillId(skill.id)}
                      className={`text-xs rounded-full px-2.5 py-1 border transition-colors ${
                        selected
                          ? "bg-ai text-white border-ai"
                          : "bg-surface-2 text-text-muted border-border hover:border-border-strong"
                      }`}
                    >
                      {skill.name}
                      {skill.categoryName && (
                        <span className="opacity-70"> · {skill.categoryName}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
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
            <div>
              <p className={labelClass}>Target skills for this course</p>
              {skillOptions.length === 0 ? (
                <p className="text-xs text-text-muted">No skills configured yet.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {skillOptions.map((skill) => {
                    const selected = selectedSkillIds.includes(skill.id);
                    return (
                      <button
                        key={skill.id}
                        type="button"
                        onClick={() => toggleSkillId(skill.id)}
                        className={`text-xs rounded-full px-2.5 py-1 border transition-colors ${
                          selected
                            ? "bg-ai text-white border-ai"
                            : "bg-surface-2 text-text-muted border-border hover:border-border-strong"
                        }`}
                      >
                        {skill.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
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
                <div className="space-y-3">
                  {section.lessons.map((lesson, li) => {
                    const key = lessonKey(si, li);
                    const lessonState = review[key];
                    return (
                      <div
                        key={`${lesson.title}-${li}`}
                        className="rounded-md bg-surface-2 px-3 py-2.5 space-y-2"
                      >
                        <div className="flex items-start justify-between gap-3">
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

                        {knowledgeOptions.length > 0 && (
                          <select
                            value={lessonState?.knowledgeDocumentId ?? ""}
                            onChange={(e) =>
                              updateLessonReview(key, {
                                knowledgeDocumentId: e.target.value || undefined,
                              })
                            }
                            className="text-xs rounded-md border border-border bg-white px-2 py-1"
                          >
                            <option value="">No knowledge document</option>
                            {knowledgeOptions.map((doc) => (
                              <option key={doc.id} value={doc.id}>
                                {doc.title}
                              </option>
                            ))}
                          </select>
                        )}

                        {lesson.contentType !== "QUIZ" ? (
                          <div className="space-y-1.5">
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                disabled={lessonState?.contentStatus === "loading"}
                                onClick={() => generateLessonContent(si, li)}
                                className="flex items-center gap-1.5 text-xs font-medium text-ai bg-ai-bg rounded-md px-2.5 py-1 hover:opacity-90 transition-opacity disabled:opacity-60"
                              >
                                <Wand2 className="h-3 w-3" />
                                {lessonState?.contentStatus === "loading"
                                  ? "Generating content…"
                                  : lessonState?.textContent
                                    ? "Regenerate content"
                                    : "Generate content"}
                              </button>
                              {lessonState?.contentStatus === "error" && (
                                <span className="text-xs text-danger">
                                  {lessonState.contentError}
                                </span>
                              )}
                            </div>
                            {lessonState?.textContent !== undefined && (
                              <textarea
                                value={lessonState.textContent}
                                onChange={(e) =>
                                  updateLessonReview(key, { textContent: e.target.value })
                                }
                                rows={5}
                                className={`${inputClass} font-mono text-xs`}
                              />
                            )}
                          </div>
                        ) : (
                          <div className="space-y-2">
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                disabled={lessonState?.quizStatus === "loading"}
                                onClick={() => generateLessonQuiz(si, li)}
                                className="flex items-center gap-1.5 text-xs font-medium text-ai bg-ai-bg rounded-md px-2.5 py-1 hover:opacity-90 transition-opacity disabled:opacity-60"
                              >
                                <Wand2 className="h-3 w-3" />
                                {lessonState?.quizStatus === "loading"
                                  ? "Generating quiz…"
                                  : lessonState?.assessment
                                    ? "Regenerate quiz"
                                    : "Generate quiz"}
                              </button>
                              {lessonState?.quizStatus === "error" && (
                                <span className="text-xs text-danger">{lessonState.quizError}</span>
                              )}
                            </div>

                            {lessonState?.assessment && (
                              <div className="space-y-3">
                                {lessonState.assessment.questions.map((q, qi) => (
                                  <div
                                    key={q.uiId}
                                    className="rounded-md border border-border bg-white p-2.5 space-y-1.5"
                                  >
                                    <input
                                      value={q.question}
                                      onChange={(e) =>
                                        updateQuestionText(si, li, qi, e.target.value)
                                      }
                                      className="w-full text-xs font-medium bg-transparent focus:outline-none"
                                    />
                                    <div className="space-y-1">
                                      {q.options.map((opt, oi) => (
                                        <label
                                          key={opt.id}
                                          className="flex items-center gap-2 text-xs"
                                        >
                                          <input
                                            type="radio"
                                            name={`${key}-q-${qi}-correct`}
                                            checked={q.correctAnswer === opt.id}
                                            onChange={() => updateCorrectAnswer(si, li, qi, opt.id)}
                                          />
                                          <input
                                            value={opt.text}
                                            onChange={(e) =>
                                              updateOptionText(si, li, qi, oi, e.target.value)
                                            }
                                            className="flex-1 rounded border border-border px-1.5 py-0.5"
                                          />
                                        </label>
                                      ))}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
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
