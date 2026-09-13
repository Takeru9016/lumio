"use client";

import { useState } from "react";
import { AiBadge, EmptyState } from "@/components";

const EXAMPLE_QUERIES = [
  "What does our onboarding policy say about probation periods?",
  "Summarize the key points from our security guidelines.",
];

type AISearchCitation = {
  documentId: string;
  documentTitle: string;
  sourceId: string;
  excerpt: string;
  score: number;
};

type SearchResult = {
  answer: string;
  citations: AISearchCitation[];
};

type Status = "idle" | "loading" | "error";

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SearchResult | null>(null);

  async function runSearch(q: string) {
    const trimmed = q.trim();
    if (!trimmed || status === "loading") return;

    setStatus("loading");
    setError(null);

    try {
      const res = await fetch("/api/ai/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: trimmed }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? "Search failed. Please try again.");
        setStatus("error");
        return;
      }

      const data = (await res.json()) as SearchResult;
      setResult(data);
      setStatus("idle");
    } catch {
      setError("Search failed. Please try again.");
      setStatus("error");
    }
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="mb-6">
        <h1
          className="text-xl font-bold text-text-primary"
          style={{ fontFamily: "var(--font-heading)" }}
        >
          Search
        </h1>
        <p className="text-sm text-text-muted">
          Ask a question and get an answer grounded in your organisation&apos;s Knowledge base.
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void runSearch(query);
        }}
        className="flex gap-2 mb-6"
      >
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Ask anything about your organisation's knowledge..."
          maxLength={2000}
          disabled={status === "loading"}
          className="flex-1 rounded-md border border-border px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-brand disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={status === "loading" || query.trim().length === 0}
          className="bg-brand text-white rounded-md px-4 py-2 text-sm font-medium hover:bg-brand-dark transition-colors disabled:opacity-50"
        >
          {status === "loading" ? "Searching..." : "Search"}
        </button>
      </form>

      {status === "idle" && !result && (
        <EmptyState
          title="Ask your first question"
          description="Search answers questions using the Knowledge documents you're permitted to read — try one of these:"
        />
      )}

      {status === "idle" && !result && (
        <div className="flex flex-col gap-2 -mt-8">
          {EXAMPLE_QUERIES.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => {
                setQuery(example);
                void runSearch(example);
              }}
              className="text-left text-sm text-brand hover:underline"
            >
              &ldquo;{example}&rdquo;
            </button>
          ))}
        </div>
      )}

      {status === "loading" && (
        <div className="animate-pulse space-y-3">
          <div className="h-4 bg-surface-3 rounded w-1/4" />
          <div className="h-20 bg-surface-3 rounded" />
          <div className="h-4 bg-surface-3 rounded w-1/3 mt-4" />
          <div className="h-16 bg-surface-3 rounded" />
        </div>
      )}

      {status === "error" && (
        <div className="rounded-md border border-border bg-surface-2 px-4 py-3">
          <p className="text-sm text-text-primary font-medium">{error}</p>
          <button
            type="button"
            onClick={() => void runSearch(query)}
            className="mt-2 text-sm text-brand hover:underline"
          >
            Try again
          </button>
        </div>
      )}

      {status === "idle" && result && (
        <div className="space-y-6">
          <div className="rounded-lg border border-border bg-surface-1 p-4 shadow-sm">
            <div className="mb-2">
              <AiBadge label="AI Search" size="md" />
            </div>
            <p className="text-sm text-text-primary whitespace-pre-wrap">{result.answer}</p>
          </div>

          {result.citations.length > 0 && (
            <div>
              <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">
                Sources
              </h2>
              <div className="flex flex-col gap-2">
                {result.citations.map((citation) => (
                  <div
                    key={citation.documentId}
                    className="rounded-md border border-border bg-surface-1 px-3 py-2"
                  >
                    <p className="text-sm font-medium text-text-primary">
                      {citation.documentTitle}
                    </p>
                    <p className="text-xs text-text-muted mt-1 line-clamp-2">{citation.excerpt}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
