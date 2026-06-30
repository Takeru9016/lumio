"use client";

import { useState, useEffect } from "react";
import { CheckCircle2, XCircle, RotateCcw, Loader2 } from "lucide-react";
import { format } from "date-fns";
import { toast } from "gooey-toast";

export interface StudentQuestion {
  id: string;
  question: string;
  type: string;
  options: { id: string; text: string }[] | null;
  order: number;
}

export interface QuizData {
  id: string;
  title: string;
  passingScore: number;
  questions: StudentQuestion[];
}

export interface AttemptSummary {
  id: string;
  score: number;
  isPassed: boolean;
  completedAt: string;
}

interface AttemptResult {
  attemptId: string;
  score: number;
  isPassed: boolean;
  xpAwarded: number;
  correctAnswers: {
    questionId: string;
    correctAnswer: string;
    explanation: string | null;
  }[];
}

type QuizPhase = "idle" | "taking" | "results";

interface StudentQuizProps {
  quiz: QuizData | null;
  initialAttempts: AttemptSummary[];
  onComplete?: () => void;
}

function displayAnswer(
  answer: string,
  question: StudentQuestion,
): string {
  if (question.type === "MCQ" && question.options) {
    return question.options.find((o) => o.id === answer)?.text ?? answer;
  }
  if (question.type === "TRUE_FALSE") {
    return answer === "true" ? "True" : answer === "false" ? "False" : answer;
  }
  return answer;
}

export function StudentQuiz({ quiz, initialAttempts, onComplete }: StudentQuizProps) {
  const [phase, setPhase] = useState<QuizPhase>("idle");
  const [currentQ, setCurrentQ] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [result, setResult] = useState<AttemptResult | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [attempts, setAttempts] = useState<AttemptSummary[]>(initialAttempts);

  useEffect(() => {
    if (!result || result.xpAwarded === 0) return;
    toast.success({
      title: `+${result.xpAwarded} XP earned!`,
      description:
        result.score === 100 ? "Perfect score! Outstanding!" : "Quiz passed!",
    });
  }, [result]);

  if (!quiz) {
    return (
      <div className="rounded-lg border border-border bg-surface-2 px-6 py-10 text-center">
        <p className="text-sm font-medium text-text-primary mb-1">
          Quiz not set up yet
        </p>
        <p className="text-xs text-text-muted">
          The instructor hasn&apos;t added questions for this lesson.
        </p>
      </div>
    );
  }

  const { questions } = quiz;
  const totalQ = questions.length;

  if (totalQ === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface-2 px-6 py-10 text-center">
        <p className="text-sm font-medium text-text-primary mb-1">
          Quiz has no questions
        </p>
        <p className="text-xs text-text-muted">Check back later.</p>
      </div>
    );
  }

  async function submitQuiz() {
    if (!quiz) return;
    setIsSubmitting(true);
    try {
      const res = await fetch(`/api/quizzes/${quiz.id}/attempt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          answers: Object.entries(answers).map(([questionId, answer]) => ({
            questionId,
            answer,
          })),
        }),
      });
      if (!res.ok) throw new Error();
      const data = (await res.json()) as AttemptResult;
      setResult(data);
      setAttempts((prev) => [
        {
          id: data.attemptId,
          score: data.score,
          isPassed: data.isPassed,
          completedAt: new Date().toISOString(),
        },
        ...prev,
      ]);
      setPhase("results");
      if (data.isPassed) onComplete?.();
    } catch {
      toast.error({ title: "Failed to submit quiz. Please try again." });
    } finally {
      setIsSubmitting(false);
    }
  }

  function startQuiz() {
    setCurrentQ(0);
    setAnswers({});
    setResult(null);
    setPhase("taking");
  }

  // ─── Idle / History ───────────────────────────────────────────────────────

  if (phase === "idle") {
    const bestScore =
      attempts.length > 0 ? Math.max(...attempts.map((a) => a.score)) : null;

    return (
      <div className="space-y-4">
        <div className="bg-surface-1 border border-border rounded-lg p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-text-primary">
                {quiz.title}
              </h2>
              <p className="text-sm text-text-muted mt-0.5">
                {totalQ} question{totalQ !== 1 ? "s" : ""} · Passing score{" "}
                {quiz.passingScore}%
              </p>
            </div>
            <button
              type="button"
              onClick={startQuiz}
              className="shrink-0 px-4 py-2 bg-brand text-white text-sm font-medium rounded-md hover:bg-brand-dark transition-colors"
            >
              {attempts.length > 0 ? "Try again" : "Start Quiz"}
            </button>
          </div>

          {bestScore !== null && (
            <div className="mt-4 pt-4 border-t border-border">
              <p className="text-xs font-medium text-text-secondary mb-3">
                Your best score:{" "}
                <span className="text-text-primary font-semibold">
                  {bestScore}%
                </span>{" "}
                · {attempts.length} attempt{attempts.length !== 1 ? "s" : ""}
              </p>
              <div className="space-y-1.5">
                {attempts.map((attempt, i) => (
                  <div
                    key={attempt.id}
                    className="flex items-center justify-between text-xs"
                  >
                    <span className="text-text-muted">
                      Attempt {attempts.length - i}
                    </span>
                    <div className="flex items-center gap-3">
                      <span className="font-medium text-text-primary">
                        {attempt.score}%
                      </span>
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                          attempt.isPassed
                            ? "bg-success-bg text-success"
                            : "bg-danger-bg text-danger"
                        }`}
                      >
                        {attempt.isPassed ? "Pass" : "Fail"}
                      </span>
                      <span className="text-text-disabled">
                        {format(new Date(attempt.completedAt), "MMM d, yyyy")}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ─── Taking ───────────────────────────────────────────────────────────────

  if (phase === "taking") {
    const q = questions[currentQ];
    const isLast = currentQ === totalQ - 1;
    const currentAnswer = answers[q.id] ?? "";

    return (
      <div className="space-y-4">
        {/* Progress bar */}
        <div className="flex items-center gap-3">
          <span className="text-xs text-text-muted shrink-0">
            Q {currentQ + 1} of {totalQ}
          </span>
          <div className="flex-1 h-1.5 bg-surface-3 rounded-full overflow-hidden">
            <div
              className="h-full bg-brand rounded-full transition-all duration-300"
              style={{ width: `${((currentQ + 1) / totalQ) * 100}%` }}
            />
          </div>
        </div>

        {/* Question card */}
        <div className="bg-surface-1 border border-border rounded-lg p-5 space-y-4">
          <p className="text-base font-medium text-text-primary">
            {q.question}
          </p>

          {/* MCQ */}
          {q.type === "MCQ" && q.options && (
            <div className="space-y-2">
              {q.options.map((opt) => (
                <label
                  key={opt.id}
                  className={`flex items-center gap-3 p-3 border rounded-lg cursor-pointer transition-colors ${
                    currentAnswer === opt.id
                      ? "border-brand bg-brand-light"
                      : "border-border hover:border-brand-light hover:bg-surface-2"
                  }`}
                >
                  <input
                    type="radio"
                    name={`q-${q.id}`}
                    checked={currentAnswer === opt.id}
                    onChange={() =>
                      setAnswers((prev) => ({ ...prev, [q.id]: opt.id }))
                    }
                    className="sr-only"
                  />
                  <span
                    className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${
                      currentAnswer === opt.id
                        ? "border-brand"
                        : "border-border"
                    }`}
                  >
                    {currentAnswer === opt.id && (
                      <span className="w-2 h-2 rounded-full bg-brand" />
                    )}
                  </span>
                  <span className="text-sm text-text-primary">{opt.text}</span>
                </label>
              ))}
            </div>
          )}

          {/* True / False */}
          {q.type === "TRUE_FALSE" && (
            <div className="flex gap-3">
              {(["true", "false"] as const).map((val) => (
                <button
                  key={val}
                  type="button"
                  onClick={() =>
                    setAnswers((prev) => ({ ...prev, [q.id]: val }))
                  }
                  className={`flex-1 py-3 rounded-lg border-2 text-sm font-medium capitalize transition-colors ${
                    currentAnswer === val
                      ? "border-brand bg-brand-light text-brand"
                      : "border-border text-text-muted hover:border-brand-light"
                  }`}
                >
                  {val === "true" ? "True" : "False"}
                </button>
              ))}
            </div>
          )}

          {/* Short Answer */}
          {q.type === "SHORT_ANSWER" && (
            <div>
              <textarea
                value={currentAnswer}
                onChange={(e) =>
                  setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))
                }
                rows={4}
                placeholder="Type your answer…"
                className="w-full border border-border rounded-lg px-3 py-2.5 text-sm text-text-primary bg-surface-2 focus:outline-none focus:border-brand resize-none"
              />
              <p className="text-xs text-text-muted mt-1">
                Short answers are graded manually by the instructor.
              </p>
            </div>
          )}
        </div>

        {/* Navigation */}
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => setCurrentQ((p) => p - 1)}
            disabled={currentQ === 0}
            className="px-3 py-1.5 text-sm text-text-muted border border-border rounded-md hover:bg-surface-2 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            ← Back
          </button>

          {isLast ? (
            <button
              type="button"
              onClick={() => void submitQuiz()}
              disabled={isSubmitting}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-brand text-white text-sm font-medium rounded-md hover:bg-brand-dark disabled:opacity-50 transition-colors"
            >
              {isSubmitting ? (
                <Loader2 size={13} className="animate-spin" />
              ) : null}
              Submit Quiz
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setCurrentQ((p) => p + 1)}
              className="px-4 py-1.5 bg-brand text-white text-sm font-medium rounded-md hover:bg-brand-dark transition-colors"
            >
              Next →
            </button>
          )}
        </div>
      </div>
    );
  }

  // ─── Results ──────────────────────────────────────────────────────────────

  if (phase === "results" && result) {
    const correctMap = new Map(
      result.correctAnswers.map((ca) => [ca.questionId, ca]),
    );

    return (
      <div className="space-y-4">
        {/* Score summary */}
        <div className="bg-surface-1 border border-border rounded-lg p-6 text-center">
          <div className="text-5xl font-bold text-text-primary mb-2">
            {result.score}%
          </div>
          <div
            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-medium mb-2 ${
              result.isPassed
                ? "bg-success-bg text-success"
                : "bg-danger-bg text-danger"
            }`}
          >
            {result.isPassed ? (
              <CheckCircle2 size={14} />
            ) : (
              <XCircle size={14} />
            )}
            {result.isPassed ? "Passed" : "Failed"}
          </div>
          {result.xpAwarded > 0 && (
            <p className="text-sm font-medium text-text-secondary">
              +{result.xpAwarded} XP earned
            </p>
          )}
          <p className="text-xs text-text-muted mt-1">
            Passing score: {quiz.passingScore}%
          </p>
        </div>

        {/* Question review */}
        <div className="space-y-2">
          {questions.map((q, i) => {
            const studentAns = answers[q.id] ?? "";
            const correctInfo = correctMap.get(q.id);
            const isShortAnswer = q.type === "SHORT_ANSWER";
            const isCorrect =
              !isShortAnswer && studentAns === correctInfo?.correctAnswer;

            return (
              <div
                key={q.id}
                className={`bg-surface-1 border rounded-lg p-4 ${
                  isShortAnswer
                    ? "border-border"
                    : isCorrect
                      ? "border-success"
                      : "border-danger"
                }`}
              >
                <div className="flex items-start gap-2.5">
                  {isShortAnswer ? (
                    <span className="mt-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded bg-surface-3 text-text-muted shrink-0">
                      Manual
                    </span>
                  ) : isCorrect ? (
                    <CheckCircle2
                      size={16}
                      className="mt-0.5 text-success shrink-0"
                    />
                  ) : (
                    <XCircle
                      size={16}
                      className="mt-0.5 text-danger shrink-0"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-text-primary">
                      {i + 1}. {q.question}
                    </p>
                    <p className="text-xs text-text-muted mt-1">
                      Your answer:{" "}
                      <span className="text-text-secondary">
                        {studentAns
                          ? displayAnswer(studentAns, q)
                          : "(not answered)"}
                      </span>
                    </p>
                    {!isShortAnswer && !isCorrect && correctInfo && (
                      <p className="text-xs text-success mt-0.5">
                        Correct:{" "}
                        {displayAnswer(correctInfo.correctAnswer, q)}
                      </p>
                    )}
                    {correctInfo?.explanation && (
                      <p className="text-xs text-text-muted mt-1 italic">
                        {correctInfo.explanation}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Try again */}
        <div className="flex justify-end">
          <button
            type="button"
            onClick={startQuiz}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium border border-border rounded-md text-text-primary hover:bg-surface-2 transition-colors"
          >
            <RotateCcw size={13} />
            Try again
          </button>
        </div>
      </div>
    );
  }

  return null;
}
