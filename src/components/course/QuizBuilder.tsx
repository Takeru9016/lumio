"use client";

import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { toast } from "gooey-toast";
import { GripVertical, HelpCircle, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { nanoid } from "nanoid";
import { useCallback, useEffect, useState } from "react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

type QuestionType = "MCQ" | "TRUE_FALSE" | "SHORT_ANSWER";

interface MCQOption {
  id: string;
  text: string;
}

interface AiQuestion {
  question: string;
  type: "MCQ" | "TRUE_FALSE";
  options?: MCQOption[];
  correctAnswer: string;
  explanation: string;
}

interface BuilderQuestion {
  localId: string;
  type: QuestionType;
  question: string;
  options: MCQOption[];
  correctAnswer: string;
  explanation: string;
}

const TYPE_LABELS: Record<QuestionType, string> = {
  MCQ: "Multiple Choice",
  TRUE_FALSE: "True / False",
  SHORT_ANSWER: "Short Answer",
};

const OPTION_IDS = ["a", "b", "c", "d"];

function defaultForm(): {
  type: QuestionType;
  questionText: string;
  optionTexts: [string, string, string, string];
  correctOptionIdx: number;
  correctTF: "true" | "false";
  sampleAnswer: string;
  explanation: string;
} {
  return {
    type: "MCQ",
    questionText: "",
    optionTexts: ["", "", "", ""],
    correctOptionIdx: 0,
    correctTF: "true",
    sampleAnswer: "",
    explanation: "",
  };
}

function questionToForm(q: BuilderQuestion) {
  if (q.type === "MCQ") {
    const texts: [string, string, string, string] = ["", "", "", ""];
    q.options.forEach((opt, i) => {
      if (i < 4) texts[i] = opt.text;
    });
    const correctIdx = q.options.findIndex((o) => o.id === q.correctAnswer);
    return {
      type: "MCQ" as QuestionType,
      questionText: q.question,
      optionTexts: texts,
      correctOptionIdx: correctIdx >= 0 ? correctIdx : 0,
      correctTF: "true" as const,
      sampleAnswer: "",
      explanation: q.explanation,
    };
  }
  if (q.type === "TRUE_FALSE") {
    return {
      type: "TRUE_FALSE" as QuestionType,
      questionText: q.question,
      optionTexts: ["", "", "", ""] as [string, string, string, string],
      correctOptionIdx: 0,
      correctTF: (q.correctAnswer === "true" ? "true" : "false") as "true" | "false",
      sampleAnswer: "",
      explanation: q.explanation,
    };
  }
  return {
    type: "SHORT_ANSWER" as QuestionType,
    questionText: q.question,
    optionTexts: ["", "", "", ""] as [string, string, string, string],
    correctOptionIdx: 0,
    correctTF: "true" as const,
    sampleAnswer: q.correctAnswer,
    explanation: q.explanation,
  };
}

function formToQuestion(
  form: ReturnType<typeof defaultForm>,
  localId: string
): BuilderQuestion | null {
  if (!form.questionText.trim()) return null;

  if (form.type === "MCQ") {
    const options = form.optionTexts.map((text, i) => ({
      id: OPTION_IDS[i],
      text,
    }));
    return {
      localId,
      type: "MCQ",
      question: form.questionText.trim(),
      options,
      correctAnswer: OPTION_IDS[form.correctOptionIdx],
      explanation: form.explanation.trim(),
    };
  }

  if (form.type === "TRUE_FALSE") {
    return {
      localId,
      type: "TRUE_FALSE",
      question: form.questionText.trim(),
      options: [],
      correctAnswer: form.correctTF,
      explanation: form.explanation.trim(),
    };
  }

  return {
    localId,
    type: "SHORT_ANSWER",
    question: form.questionText.trim(),
    options: [],
    correctAnswer: form.sampleAnswer.trim(),
    explanation: form.explanation.trim(),
  };
}

interface SortableQuestionItemProps {
  q: BuilderQuestion;
  index: number;
  onEdit: () => void;
  onDelete: () => void;
}

function SortableQuestionItem({ q, index, onEdit, onDelete }: SortableQuestionItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: q.localId,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-start gap-2 p-3 bg-surface-1 border border-border rounded-lg"
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="mt-0.5 cursor-grab text-text-disabled hover:text-text-muted touch-none"
      >
        <GripVertical size={15} />
      </button>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-[10px] font-medium text-text-muted bg-surface-3 px-1.5 py-0.5 rounded uppercase tracking-wide">
            {TYPE_LABELS[q.type]}
          </span>
          <span className="text-[10px] text-text-disabled">#{index + 1}</span>
        </div>
        <p className="text-sm text-text-primary truncate">{q.question}</p>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={onEdit}
          className="p-1 rounded hover:bg-surface-3 text-text-muted hover:text-text-primary transition-colors"
        >
          <Pencil size={13} />
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="p-1 rounded hover:bg-danger-bg text-text-muted hover:text-danger transition-colors"
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}

interface QuestionFormProps {
  initial: ReturnType<typeof defaultForm>;
  onSave: (form: ReturnType<typeof defaultForm>) => void;
  onCancel: () => void;
}

function QuestionForm({ initial, onSave, onCancel }: QuestionFormProps) {
  const [form, setForm] = useState(initial);
  const [error, setError] = useState("");

  function handleSave() {
    if (!form.questionText.trim()) {
      setError("Question text is required.");
      return;
    }
    if (form.type === "MCQ") {
      const filled = form.optionTexts.filter((t) => t.trim());
      if (filled.length < 2) {
        setError("Add at least 2 options for multiple choice.");
        return;
      }
    }
    setError("");
    onSave(form);
  }

  return (
    <div className="space-y-4">
      {/* Type selector */}
      <div className="flex gap-1.5">
        {(["MCQ", "TRUE_FALSE", "SHORT_ANSWER"] as QuestionType[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setForm((f) => ({ ...f, type: t }))}
            className={`flex-1 py-1.5 px-2 text-xs font-medium rounded-md border transition-colors ${
              form.type === t
                ? "bg-brand text-white border-brand"
                : "bg-surface-2 text-text-muted border-border hover:border-brand hover:text-brand"
            }`}
          >
            {TYPE_LABELS[t]}
          </button>
        ))}
      </div>

      {/* Question */}
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1">Question</label>
        <textarea
          value={form.questionText}
          onChange={(e) => setForm((f) => ({ ...f, questionText: e.target.value }))}
          rows={2}
          placeholder="Enter your question…"
          className="w-full border border-border rounded-md px-3 py-2 text-sm text-text-primary bg-surface-1 focus:outline-none focus:border-brand resize-none"
        />
      </div>

      {/* MCQ options */}
      {form.type === "MCQ" && (
        <div className="space-y-2">
          <label className="block text-xs font-medium text-text-secondary">
            Options — select the correct answer
          </label>
          {form.optionTexts.map((text, i) => (
            <div key={OPTION_IDS[i]} className="flex items-center gap-2">
              <input
                type="radio"
                name="correct-option"
                checked={form.correctOptionIdx === i}
                onChange={() => setForm((f) => ({ ...f, correctOptionIdx: i }))}
                className="accent-brand shrink-0"
              />
              <span className="text-xs text-text-disabled font-mono w-4 shrink-0">
                {OPTION_IDS[i].toUpperCase()}
              </span>
              <input
                type="text"
                value={text}
                onChange={(e) => {
                  const next = [...form.optionTexts] as [string, string, string, string];
                  next[i] = e.target.value;
                  setForm((f) => ({ ...f, optionTexts: next }));
                }}
                placeholder={`Option ${OPTION_IDS[i].toUpperCase()}`}
                className="flex-1 border border-border rounded-md px-3 py-1.5 text-sm text-text-primary bg-surface-1 focus:outline-none focus:border-brand"
              />
            </div>
          ))}
        </div>
      )}

      {/* True / False */}
      {form.type === "TRUE_FALSE" && (
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-2">
            Correct answer
          </label>
          <div className="flex gap-3">
            {(["true", "false"] as const).map((val) => (
              <button
                key={val}
                type="button"
                onClick={() => setForm((f) => ({ ...f, correctTF: val }))}
                className={`flex-1 py-2 rounded-lg border-2 text-sm font-medium capitalize transition-colors ${
                  form.correctTF === val
                    ? "border-brand bg-brand-light text-brand"
                    : "border-border text-text-muted hover:border-brand-light"
                }`}
              >
                {val === "true" ? "True" : "False"}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Short answer */}
      {form.type === "SHORT_ANSWER" && (
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">
            Sample answer{" "}
            <span className="text-text-disabled font-normal">(for manual grading reference)</span>
          </label>
          <textarea
            value={form.sampleAnswer}
            onChange={(e) => setForm((f) => ({ ...f, sampleAnswer: e.target.value }))}
            rows={2}
            placeholder="Example correct answer…"
            className="w-full border border-border rounded-md px-3 py-2 text-sm text-text-primary bg-surface-1 focus:outline-none focus:border-brand resize-none"
          />
        </div>
      )}

      {/* Explanation */}
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1">
          Explanation <span className="text-text-disabled font-normal">(optional)</span>
        </label>
        <input
          type="text"
          value={form.explanation}
          onChange={(e) => setForm((f) => ({ ...f, explanation: e.target.value }))}
          placeholder="Shown after submission…"
          className="w-full border border-border rounded-md px-3 py-2 text-sm text-text-primary bg-surface-1 focus:outline-none focus:border-brand"
        />
      </div>

      {error && <p className="text-xs text-danger">{error}</p>}

      <div className="flex justify-end gap-2 pt-2 border-t border-border">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-sm text-text-muted border border-border rounded-md hover:bg-surface-2 transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          className="px-4 py-1.5 text-sm font-medium bg-brand text-white rounded-md hover:bg-brand-dark transition-colors"
        >
          Save question
        </button>
      </div>
    </div>
  );
}

interface QuizBuilderProps {
  courseId: string;
  lessonId: string;
}

export function QuizBuilder({ courseId, lessonId }: QuizBuilderProps) {
  const [questions, setQuestions] = useState<BuilderQuestion[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [dialogForm, setDialogForm] = useState<ReturnType<typeof defaultForm>>(defaultForm);

  // AI generation + preview
  const [isGenerating, setIsGenerating] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewQuestions, setPreviewQuestions] = useState<BuilderQuestion[]>([]);
  const [previewEditIndex, setPreviewEditIndex] = useState<number | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const fetchQuiz = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch(`/api/courses/${courseId}/lessons/${lessonId}/quiz`);
      if (!res.ok) return;
      const data = (await res.json()) as {
        quiz: {
          questions: {
            id: string;
            type: string;
            question: string;
            options: MCQOption[] | null;
            correctAnswer: string;
            explanation: string | null;
          }[];
        } | null;
      };
      if (data.quiz?.questions) {
        setQuestions(
          data.quiz.questions.map((q) => ({
            localId: q.id,
            type: q.type as QuestionType,
            question: q.question,
            options: (q.options as MCQOption[]) ?? [],
            correctAnswer: q.correctAnswer,
            explanation: q.explanation ?? "",
          }))
        );
      }
    } catch {
      // use empty state
    } finally {
      setIsLoading(false);
    }
  }, [courseId, lessonId]);

  useEffect(() => {
    void fetchQuiz();
  }, [fetchQuiz]);

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setQuestions((prev) => {
      const oldIdx = prev.findIndex((q) => q.localId === active.id);
      const newIdx = prev.findIndex((q) => q.localId === over.id);
      return arrayMove(prev, oldIdx, newIdx);
    });
  }

  function openAdd() {
    setEditingIndex(null);
    setDialogForm(defaultForm());
    setDialogOpen(true);
  }

  function openEdit(index: number) {
    setEditingIndex(index);
    setDialogForm(questionToForm(questions[index]));
    setDialogOpen(true);
  }

  function handleSaveQuestion(form: ReturnType<typeof defaultForm>) {
    const localId = editingIndex !== null ? questions[editingIndex].localId : nanoid();
    const q = formToQuestion(form, localId);
    if (!q) return;

    if (editingIndex !== null) {
      setQuestions((prev) => prev.map((item, i) => (i === editingIndex ? q : item)));
    } else {
      setQuestions((prev) => [...prev, q]);
    }
    setDialogOpen(false);
  }

  function deleteQuestion(index: number) {
    setQuestions((prev) => prev.filter((_, i) => i !== index));
  }

  // Persists a set of questions to the lesson quiz. `aiGenerated` is only sent
  // when true so a manual re-save never clears the AI-generated flag.
  async function persistQuestions(qs: BuilderQuestion[], aiGenerated: boolean): Promise<boolean> {
    const res = await fetch(`/api/courses/${courseId}/lessons/${lessonId}/quiz`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Quiz",
        passingScore: 70,
        ...(aiGenerated ? { isAiGenerated: true } : {}),
        questions: qs.map((q, i) => ({
          question: q.question,
          type: q.type,
          options: q.options.length > 0 ? q.options : null,
          correctAnswer: q.correctAnswer,
          explanation: q.explanation || null,
          order: i,
        })),
      }),
    });
    return res.ok;
  }

  async function saveQuiz() {
    if (questions.length === 0) {
      toast.error({ title: "Add at least one question before saving." });
      return;
    }
    setIsSaving(true);
    try {
      const ok = await persistQuestions(questions, false);
      if (!ok) throw new Error();
      toast.success({ title: "Quiz saved" });
      await fetchQuiz();
    } catch {
      toast.error({ title: "Failed to save quiz" });
    } finally {
      setIsSaving(false);
    }
  }

  async function generateQuiz() {
    setIsGenerating(true);
    try {
      const res = await fetch("/api/ai/quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lessonId }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          upgradeRequired?: boolean;
        };
        if (res.status === 429) {
          toast.error({
            title: "Rate limit reached",
            description: "Too many requests — try again in a minute.",
          });
        } else if (res.status === 403 && data.upgradeRequired) {
          toast.error({
            title: "AI quota reached",
            description: "Upgrade your plan to generate more quizzes.",
          });
        } else {
          toast.error({
            title: "Couldn't generate quiz",
            description: data.error ?? "Please try again.",
          });
        }
        return;
      }

      const data = (await res.json()) as { questions: AiQuestion[] };
      setPreviewQuestions(
        data.questions.map((q) => ({
          localId: nanoid(),
          type: q.type,
          question: q.question,
          options: q.options ?? [],
          correctAnswer: q.correctAnswer,
          explanation: q.explanation ?? "",
        }))
      );
      setPreviewEditIndex(null);
      setPreviewOpen(true);
    } catch {
      toast.error({
        title: "Network error",
        description: "Couldn't reach the AI service.",
      });
    } finally {
      setIsGenerating(false);
    }
  }

  async function approvePreview() {
    if (previewQuestions.length === 0) return;
    setIsApproving(true);
    try {
      const ok = await persistQuestions(previewQuestions, true);
      if (!ok) throw new Error();
      toast.success({ title: "AI quiz saved" });
      setPreviewOpen(false);
      await fetchQuiz();
    } catch {
      toast.error({ title: "Failed to save quiz" });
    } finally {
      setIsApproving(false);
    }
  }

  function savePreviewQuestion(form: ReturnType<typeof defaultForm>) {
    if (previewEditIndex === null) return;
    const q = formToQuestion(form, previewQuestions[previewEditIndex].localId);
    if (!q) return;
    setPreviewQuestions((prev) => prev.map((item, i) => (i === previewEditIndex ? q : item)));
    setPreviewEditIndex(null);
  }

  function deletePreviewQuestion(index: number) {
    setPreviewQuestions((prev) => prev.filter((_, i) => i !== index));
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 size={20} className="animate-spin text-text-muted" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-text-primary">Quiz Questions</p>
          <p className="text-xs text-text-muted">
            {questions.length === 0
              ? "No questions yet"
              : `${questions.length} question${questions.length !== 1 ? "s" : ""} · Passing score 70%`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void saveQuiz()}
          disabled={isSaving}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-brand text-white rounded-md hover:bg-brand-dark disabled:opacity-50 transition-colors"
        >
          {isSaving ? <Loader2 size={13} className="animate-spin" /> : null}
          Save quiz
        </button>
      </div>

      {/* Questions list */}
      {questions.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-surface-2 py-10 text-center">
          <HelpCircle size={24} className="text-text-disabled mx-auto mb-2" />
          <p className="text-sm text-text-muted">No questions added yet</p>
          <p className="text-xs text-text-disabled mt-0.5">
            Click &quot;Add question&quot; to start building the quiz
          </p>
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext
            items={questions.map((q) => q.localId)}
            strategy={verticalListSortingStrategy}
          >
            <div className="space-y-2">
              {questions.map((q, i) => (
                <SortableQuestionItem
                  key={q.localId}
                  q={q}
                  index={i}
                  onEdit={() => openEdit(i)}
                  onDelete={() => deleteQuestion(i)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {/* Add question */}
      <button
        type="button"
        onClick={openAdd}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border py-2.5 text-sm text-text-muted hover:border-brand hover:text-brand transition-colors"
      >
        <Plus size={14} />
        Add question
      </button>

      {/* AI generation */}
      <button
        type="button"
        onClick={() => void generateQuiz()}
        disabled={isGenerating}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-ai bg-ai-bg py-2.5 text-sm font-medium text-ai hover:bg-ai hover:text-white disabled:opacity-60 transition-colors"
      >
        {isGenerating ? (
          <>
            <Loader2 size={14} className="animate-spin" />
            Generating quiz…
          </>
        ) : (
          "✦ Generate Quiz"
        )}
      </button>

      {/* Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogTitle>{editingIndex !== null ? "Edit question" : "Add question"}</DialogTitle>
          <QuestionForm
            initial={dialogForm}
            onSave={handleSaveQuestion}
            onCancel={() => setDialogOpen(false)}
          />
        </DialogContent>
      </Dialog>

      {/* AI preview */}
      <Dialog
        open={previewOpen}
        onOpenChange={(open) => {
          if (isApproving) return;
          setPreviewOpen(open);
          if (!open) setPreviewEditIndex(null);
        }}
      >
        <DialogContent className="max-w-lg">
          {previewEditIndex !== null ? (
            <>
              <DialogTitle>Edit question</DialogTitle>
              <QuestionForm
                initial={questionToForm(previewQuestions[previewEditIndex])}
                onSave={savePreviewQuestion}
                onCancel={() => setPreviewEditIndex(null)}
              />
            </>
          ) : (
            <>
              <DialogTitle className="flex items-center gap-1.5 text-ai">
                ✦ AI-generated quiz
              </DialogTitle>
              <p className="text-xs text-text-muted -mt-2">
                Review the {previewQuestions.length} generated question
                {previewQuestions.length !== 1 ? "s" : ""} before saving. Edit or regenerate as
                needed.
              </p>

              <div className="max-h-[50vh] space-y-2 overflow-y-auto py-1">
                {previewQuestions.map((q, i) => (
                  <div
                    key={q.localId}
                    className="flex items-start gap-2 rounded-lg border border-border bg-surface-1 p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="mb-0.5 flex items-center gap-2">
                        <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-muted">
                          {TYPE_LABELS[q.type]}
                        </span>
                        <span className="text-[10px] text-text-disabled">#{i + 1}</span>
                      </div>
                      <p className="text-sm text-text-primary">{q.question}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setPreviewEditIndex(i)}
                        className="rounded p-1 text-text-muted transition-colors hover:bg-surface-3 hover:text-text-primary"
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        type="button"
                        onClick={() => deletePreviewQuestion(i)}
                        className="rounded p-1 text-text-muted transition-colors hover:bg-danger-bg hover:text-danger"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
                <button
                  type="button"
                  onClick={() => void generateQuiz()}
                  disabled={isGenerating || isApproving}
                  className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-ai hover:bg-ai-bg disabled:opacity-50 transition-colors"
                >
                  {isGenerating ? <Loader2 size={13} className="animate-spin" /> : null}
                  Regenerate
                </button>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setPreviewOpen(false)}
                    disabled={isApproving}
                    className="rounded-md border border-border px-3 py-1.5 text-sm text-text-muted hover:bg-surface-2 disabled:opacity-50 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void approvePreview()}
                    disabled={isApproving || previewQuestions.length === 0}
                    className="flex items-center gap-1.5 rounded-md bg-brand px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-50 transition-colors"
                  >
                    {isApproving ? <Loader2 size={13} className="animate-spin" /> : null}
                    Approve &amp; Save
                  </button>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
