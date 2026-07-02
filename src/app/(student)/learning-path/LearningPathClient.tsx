"use client";

import { toast } from "gooey-toast";
import { ArrowRight, Loader2, Sparkles } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { EmptyState } from "@/components";

type Priority = "HIGH" | "MEDIUM" | "LOW";

interface Recommendation {
  lessonId: string;
  reason: string;
  priority: Priority;
  lessonTitle: string;
  courseId: string;
  courseTitle: string;
}

interface LearningPathResponse {
  recommendations: Recommendation[];
  summary: string;
  error?: string;
  upgradeRequired?: boolean;
}

const PRIORITY_ORDER: Record<Priority, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

const PRIORITY_STYLES: Record<Priority, string> = {
  HIGH: "bg-danger-bg text-danger",
  MEDIUM: "bg-warning-bg text-warning",
  LOW: "bg-surface-3 text-text-muted",
};

export function LearningPathClient() {
  const [recommendations, setRecommendations] = useState<Recommendation[] | null>(null);
  const [summary, setSummary] = useState<string>("");
  const [isLoading, setIsLoading] = useState(false);

  async function generate() {
    setIsLoading(true);
    try {
      const res = await fetch("/api/ai/learning-path", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = (await res.json()) as LearningPathResponse;

      if (!res.ok) {
        toast.error({
          title: data.upgradeRequired ? "AI quota exceeded" : "Couldn't generate your path",
          description: data.error ?? "Please try again in a moment.",
        });
        return;
      }

      const sorted = [...data.recommendations].sort(
        (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
      );
      setRecommendations(sorted);
      setSummary(data.summary);
    } catch {
      toast.error({
        title: "Couldn't generate your path",
        description: "Check your connection and try again.",
      });
    } finally {
      setIsLoading(false);
    }
  }

  if (!recommendations) {
    return (
      <div className="bg-surface-1 border border-border rounded-lg">
        <EmptyState
          icon="✦"
          title="No learning path yet"
          description="Generate a personalised path based on your progress and quiz scores."
        />
        <div className="flex justify-center pb-6 -mt-2">
          <button
            type="button"
            onClick={() => void generate()}
            disabled={isLoading}
            className="flex items-center gap-2 bg-ai text-white rounded-md px-4 py-2 text-sm font-medium hover:opacity-90 disabled:opacity-60 transition-opacity"
          >
            {isLoading ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
            Generate my learning path
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="bg-ai-bg border border-ai-border rounded-lg p-4">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-ai mb-1">
          <Sparkles size={14} /> Your path
        </p>
        <p className="text-sm text-text-primary">{summary}</p>
      </div>

      {recommendations.length === 0 ? (
        <EmptyState
          icon="🎉"
          title="You're all caught up"
          description="There's nothing new to recommend right now — check back after your next lesson."
        />
      ) : (
        <div className="space-y-3">
          {recommendations.map((rec) => (
            <div
              key={rec.lessonId}
              className="bg-surface-1 border border-border rounded-lg p-4 flex items-start justify-between gap-4"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className={`text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 ${PRIORITY_STYLES[rec.priority]}`}
                  >
                    {rec.priority}
                  </span>
                  <span className="text-xs text-text-muted truncate">{rec.courseTitle}</span>
                </div>
                <p className="text-sm font-semibold text-text-primary">{rec.lessonTitle}</p>
                <p className="text-sm text-text-muted mt-0.5">{rec.reason}</p>
              </div>

              <Link
                href={`/courses/${rec.courseId}/lessons/${rec.lessonId}`}
                className="shrink-0 flex items-center gap-1 text-sm font-medium text-brand hover:text-brand-dark transition-colors"
              >
                Start Lesson <ArrowRight size={14} />
              </Link>
            </div>
          ))}
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void generate()}
          disabled={isLoading}
          className="flex items-center gap-2 border border-border rounded-md px-4 py-2 text-sm font-medium text-text-primary hover:bg-surface-2 disabled:opacity-60 transition-colors"
        >
          {isLoading ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
          Regenerate
        </button>
      </div>
    </div>
  );
}
