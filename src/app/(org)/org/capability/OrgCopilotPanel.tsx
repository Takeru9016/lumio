"use client";

import { useEffect, useState } from "react";
import { AiBadge } from "@/components";

const EXAMPLE_PROMPTS = [
  "Which skills are most commonly missing?",
  "Where are the largest capability gaps?",
  "What capability areas need attention?",
];

type Status = "idle" | "loading" | "error";
type ChatMessage = { role: "user" | "assistant"; content: string };
type ConversationSummary = { id: string; label: string; createdAt: string };

interface OrgCopilotPanelProps {
  selectedLearner: { id: string; name: string } | null;
  onClearLearner: () => void;
}

/**
 * Embedded Organization Capability Copilot panel (Phase 13 locked contract,
 * extended with Phase 15 conversation continuity) — Q&A over the
 * organisation's tenant-wide capability state, rendered directly on
 * /org/capability. A conversation's learner scope is fixed at creation
 * (Phase 15 contract §5/§7) — switching the selected learner always starts a
 * new conversation. Disabling input while a request is in flight is this
 * panel's half of the Phase 15 concurrency mitigation.
 */
export function OrgCopilotPanel({ selectedLearner, onClearLearner }: OrgCopilotPanelProps) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<ConversationSummary[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  useEffect(() => {
    setConversationId(null);
    setMessages([]);
    setError(null);
    setShowHistory(false);
  }, [selectedLearner?.id]);

  async function ask(q: string) {
    const trimmed = q.trim();
    if (!trimmed || status === "loading") return;

    setStatus("loading");
    setError(null);
    setMessages((prev) => [...prev, { role: "user", content: trimmed }]);

    try {
      const res = await fetch("/api/ai/org/copilot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: trimmed,
          ...(selectedLearner ? { learnerId: selectedLearner.id } : {}),
          ...(conversationId ? { conversationId } : {}),
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? "Copilot couldn't answer that. Please try again.");
        setMessages((prev) => prev.slice(0, -1));
        setStatus("error");
        return;
      }

      const data = (await res.json()) as { answer: string; conversationId?: string };
      setMessages((prev) => [...prev, { role: "assistant", content: data.answer }]);
      if (data.conversationId) setConversationId(data.conversationId);
      setStatus("idle");
    } catch {
      setError("Copilot couldn't answer that. Please try again.");
      setMessages((prev) => prev.slice(0, -1));
      setStatus("error");
    }
  }

  function startNewConversation() {
    setConversationId(null);
    setMessages([]);
    setError(null);
    setShowHistory(false);
  }

  async function toggleHistory() {
    const next = !showHistory;
    setShowHistory(next);
    if (next && history === null) {
      setHistoryLoading(true);
      try {
        const res = await fetch("/api/ai/org/copilot/conversations");
        if (res.ok) {
          const data = (await res.json()) as { conversations: ConversationSummary[] };
          setHistory(data.conversations);
        }
      } finally {
        setHistoryLoading(false);
      }
    }
  }

  async function openConversation(id: string) {
    setStatus("loading");
    setError(null);
    try {
      const res = await fetch(`/api/ai/org/copilot/conversations/${id}`);
      if (!res.ok) throw new Error();
      const data = (await res.json()) as {
        conversation: { id: string; messages: ChatMessage[] };
      };
      setMessages(data.conversation.messages);
      setConversationId(data.conversation.id);
      setShowHistory(false);
      setStatus("idle");
    } catch {
      setError("Couldn't load that conversation.");
      setStatus("error");
    }
  }

  return (
    <div className="bg-ai-bg border border-ai-border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <AiBadge label="Capability Copilot" size="md" />
        <div className="flex items-center gap-3 text-xs">
          <button type="button" onClick={toggleHistory} className="text-ai hover:underline">
            History
          </button>
          {(conversationId || messages.length > 0) && (
            <button
              type="button"
              onClick={startNewConversation}
              className="text-ai hover:underline"
            >
              New
            </button>
          )}
        </div>
      </div>
      <p className="text-xs text-text-muted">
        Ask about your organisation&apos;s roles, required skills, or capability gaps — Copilot
        explains what&apos;s already shown above, in plain language.
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

      {showHistory && (
        <div className="rounded-md border border-border bg-white px-3 py-2 space-y-1">
          {historyLoading && <p className="text-xs text-text-muted">Loading…</p>}
          {!historyLoading && history?.length === 0 && (
            <p className="text-xs text-text-muted">No previous conversations yet.</p>
          )}
          {!historyLoading &&
            history?.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => void openConversation(c.id)}
                className="block w-full text-left text-xs text-text-primary hover:text-ai truncate"
              >
                {c.label}
              </button>
            ))}
        </div>
      )}

      {messages.length > 0 && (
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {messages.map((m, i) => (
            <div
              key={`${m.role}-${i}`}
              className={`rounded-md border border-border px-3 py-2 ${
                m.role === "user" ? "bg-surface-2" : "bg-white"
              }`}
            >
              <p className="text-sm text-text-primary whitespace-pre-wrap">{m.content}</p>
            </div>
          ))}
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

      {status === "idle" && messages.length === 0 && !error && !selectedLearner && (
        <div className="flex flex-col gap-1.5">
          {EXAMPLE_PROMPTS.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => void ask(example)}
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
    </div>
  );
}
