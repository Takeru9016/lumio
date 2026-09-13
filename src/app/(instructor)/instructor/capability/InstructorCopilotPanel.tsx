"use client";

import { useState } from "react";
import { AiBadge } from "@/components";

const EXAMPLE_PROMPTS = [
  "Which skills are most commonly missing?",
  "Where are the largest capability gaps?",
  "What should I focus on with this group?",
];

type Status = "idle" | "loading" | "error";

interface InstructorCopilotPanelProps {
  selectedLearner: { id: string; name: string } | null;
  onClearLearner: () => void;
}

/**
 * Embedded Instructor Capability Copilot panel (Phase 13 locked contract) —
 * one-shot Q&A over the capability state of students enrolled in the
 * instructor's own courses, rendered directly on /instructor/capability.
 * Each query replaces the previous answer; no thread, no history. Learner
 * selection reuses the existing capability table's rows — this panel never
 * fetches learner data itself, it only forwards the id the parent page
 * already rendered.
 */
export function InstructorCopilotPanel({
  selectedLearner,
  onClearLearner,
}: InstructorCopilotPanelProps) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);

  async function ask(q: string) {
    const trimmed = q.trim();
    if (!trimmed || status === "loading") return;

    setStatus("loading");
    setError(null);

    try {
      const res = await fetch("/api/ai/instructor/copilot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          selectedLearner ? { query: trimmed, learnerId: selectedLearner.id } : { query: trimmed }
        ),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? "Copilot couldn't answer that. Please try again.");
        setAnswer(null);
        setStatus("error");
        return;
      }

      const data = (await res.json()) as { answer: string };
      setAnswer(data.answer);
      setStatus("idle");
    } catch {
      setError("Copilot couldn't answer that. Please try again.");
      setAnswer(null);
      setStatus("error");
    }
  }

  return (
    <div className="bg-ai-bg border border-ai-border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <AiBadge label="Capability Copilot" size="md" />
      </div>
      <p className="text-xs text-text-muted">
        Ask about your students&apos; roles, required skills, or capability gaps — Copilot explains
        what&apos;s already shown above, in plain language.
      </p>

      {selectedLearner && (
        <div className="flex items-center gap-2 text-xs">
          <span className="bg-white border border-border rounded-full px-2.5 py-1 text-text-primary">
            Asking about: <span className="font-medium">{selectedLearner.name}</span>
          </span>
          <button type="button" onClick={onClearLearner} className="text-ai hover:underline">
            Clear
          </button>
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask(query);
        }}
        className="flex gap-2"
      >
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Which skills are most commonly missing?"
          maxLength={2000}
          disabled={status === "loading"}
          className="flex-1 rounded-md border border-border bg-white px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-ai disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={status === "loading" || query.trim().length === 0}
          className="bg-ai text-white rounded-md px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {status === "loading" ? "Asking..." : "Ask"}
        </button>
      </form>

      {status === "idle" && !answer && !error && !selectedLearner && (
        <div className="flex flex-col gap-1.5">
          {EXAMPLE_PROMPTS.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => {
                setQuery(example);
                void ask(example);
              }}
              className="text-left text-xs text-ai hover:underline"
            >
              &ldquo;{example}&rdquo;
            </button>
          ))}
        </div>
      )}

      {status === "loading" && (
        <div className="animate-pulse space-y-2">
          <div className="h-3 bg-white/60 rounded w-2/3" />
          <div className="h-3 bg-white/60 rounded w-1/2" />
        </div>
      )}

      {status === "error" && error && (
        <div className="rounded-md border border-border bg-white px-3 py-2">
          <p className="text-xs text-text-primary">{error}</p>
          <button
            type="button"
            onClick={() => void ask(query)}
            className="mt-1 text-xs text-ai hover:underline"
          >
            Try again
          </button>
        </div>
      )}

      {status === "idle" && answer && (
        <div className="rounded-md border border-border bg-white px-3 py-2">
          <p className="text-sm text-text-primary whitespace-pre-wrap">{answer}</p>
        </div>
      )}
    </div>
  );
}
