"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { SendHorizonal } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AiBadge } from "@/components";

interface AiTutorChatProps {
  lessonId?: string;
  chatId?: string;
  courseId?: string;
  initialMessages?: UIMessage[];
  /** Fill available height (course player tab). Standalone page sets its own. */
  className?: string;
}

/** Pulls the concatenated text out of a UIMessage's parts. */
function messageText(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

export function AiTutorChat({
  lessonId,
  chatId,
  courseId,
  initialMessages,
  className = "",
}: AiTutorChatProps) {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const { messages, sendMessage, status, error } = useChat({
    id: chatId,
    messages: initialMessages,
    transport: new DefaultChatTransport({
      api: "/api/ai/tutor",
      body: { lessonId, courseId, chatId },
    }),
  });

  const isBusy = status === "submitted" || status === "streaming";
  const awaitingReply = isBusy && messages[messages.length - 1]?.role === "user";

  // biome-ignore lint/correctness/useExhaustiveDependencies: messages and awaitingReply are intentional scroll triggers — the effect body reads a ref, not these values.
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, awaitingReply]);

  function submit() {
    const text = input.trim();
    if (!text || isBusy) return;
    void sendMessage({ text });
    setInput("");
  }

  return (
    <div className={`flex flex-col ${className}`}>
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border pb-3">
        <span className="text-lg text-ai" aria-hidden>
          ✦
        </span>
        <span className="text-sm font-semibold text-text-primary">AI Tutor</span>
        <AiBadge label="AI Tutor" />
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto py-4 space-y-4">
        {messages.length === 0 && !awaitingReply ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <span className="text-3xl text-ai mb-2" aria-hidden>
              ✦
            </span>
            <p className="text-sm font-medium text-text-primary mb-1">Ask the AI Tutor anything</p>
            <p className="text-xs text-text-muted max-w-xs">
              {lessonId
                ? "Get explanations grounded in this lesson, or explore a concept deeper."
                : "Ask general learning questions and work through ideas together."}
            </p>
          </div>
        ) : (
          messages.map((message) =>
            message.role === "user" ? (
              <div key={message.id} className="flex justify-end">
                <div className="max-w-[80%] rounded-lg rounded-br-sm bg-brand px-3.5 py-2 text-sm text-white whitespace-pre-wrap break-words">
                  {messageText(message)}
                </div>
              </div>
            ) : (
              <div key={message.id} className="flex items-start gap-2.5">
                <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ai-bg text-sm text-ai">
                  ✦
                </div>
                <div className="max-w-[80%] rounded-lg rounded-tl-sm bg-surface-3 px-3.5 py-2 text-sm text-text-primary whitespace-pre-wrap break-words">
                  {messageText(message)}
                </div>
              </div>
            )
          )
        )}

        {/* Typing indicator — assistant reply not yet started */}
        {awaitingReply && (
          <div className="flex items-start gap-2.5">
            <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ai-bg text-sm text-ai">
              ✦
            </div>
            <div className="flex items-center gap-1 rounded-lg rounded-tl-sm bg-surface-3 px-3.5 py-3">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-disabled [animation-delay:-0.3s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-disabled [animation-delay:-0.15s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-disabled" />
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-md bg-danger-bg px-3 py-2 text-xs text-danger">
            Something went wrong reaching the AI Tutor. Please try again.
          </div>
        )}
      </div>

      {/* Input */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex items-end gap-2 border-t border-border pt-3"
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          placeholder="Ask a question…"
          className="flex-1 resize-none rounded-md border border-border bg-white px-3 py-2 text-sm text-text-primary placeholder:text-text-disabled focus:border-transparent focus:outline-none focus:ring-2 focus:ring-ai transition-all max-h-32"
        />
        <button
          type="submit"
          disabled={isBusy || input.trim().length === 0}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-ai text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          aria-label="Send message"
        >
          <SendHorizonal size={16} />
        </button>
      </form>
    </div>
  );
}
