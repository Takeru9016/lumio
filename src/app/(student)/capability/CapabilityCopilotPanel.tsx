"use client";

import { useEffect, useState } from "react";
import { AiBadge } from "@/components";

const EXAMPLE_PROMPTS = [
  "What am I missing for my role?",
  "What should I focus on next?",
  "Why is this skill a gap?",
];

type Status = "idle" | "loading" | "error";
type ChatMessage = { role: "user" | "assistant"; content: string };
type ConversationSummary = { id: string; label: string; createdAt: string };

/**
 * Embedded Capability Copilot panel (Phase 12 locked contract, extended with
 * Phase 15 conversation continuity) — Q&A over the learner's own
 * already-computed capability state, rendered directly on /capability.
 * Continuing a conversation sends its conversationId so the server appends
 * to bounded persisted history; "New" starts a fresh one without deleting
 * the old one. Disabling input while a request is in flight is this panel's
 * half of the Phase 15 concurrency mitigation (no server-side lock exists —
 * see contract §13/§18 — a raw concurrent client bypassing this UI is a
 * known, accepted residual risk).
 */
export function CapabilityCopilotPanel({ roleId }: { roleId: string | null }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<ConversationSummary[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Phase 21: switching the page's selected role must not let the model
  // keep reasoning from the previous role's gaps — clear any in-flight
  // conversation client-side (the server independently rejects a
  // continuation whose stored role differs; this just avoids the learner
  // hitting that 400 after switching roles on the page above this panel).
  // biome-ignore lint/correctness/useExhaustiveDependencies: roleId is intentionally a trigger-only dependency — the effect body doesn't read it, it just needs to rerun on role change.
  useEffect(() => {
    setConversationId(null);
    setMessages([]);
    setError(null);
    setShowHistory(false);
  }, [roleId]);

  async function ask(q: string) {
    const trimmed = q.trim();
    if (!trimmed || status === "loading") return;

    setStatus("loading");
    setError(null);
    setMessages((prev) => [...prev, { role: "user", content: trimmed }]);

    try {
      const res = await fetch("/api/ai/copilot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: trimmed,
          ...(conversationId ? { conversationId } : {}),
          ...(roleId ? { roleId } : {}),
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
        const res = await fetch("/api/ai/copilot/conversations");
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
      const res = await fetch(`/api/ai/copilot/conversations/${id}`);
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
        Ask about your role, required skills, gaps, or recommended courses — Copilot explains
        what&apos;s already shown above, in plain language.
      </p>

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
          placeholder="What am I missing for my role?"
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

      {status === "idle" && messages.length === 0 && !error && (
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
