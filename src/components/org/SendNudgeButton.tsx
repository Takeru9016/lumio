"use client";

import { toast } from "gooey-toast";
import { useState } from "react";

interface SendNudgeButtonProps {
  trainingId: string;
}

export function SendNudgeButton({ trainingId }: SendNudgeButtonProps) {
  const [isSending, setIsSending] = useState(false);

  async function handleClick() {
    setIsSending(true);
    try {
      const res = await fetch("/api/org/nudge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trainingId }),
      });
      if (!res.ok) throw new Error();
      const { sent } = await res.json();
      toast.success({ title: `Nudge sent to ${sent} member${sent === 1 ? "" : "s"}` });
    } catch {
      toast.error({ title: "Couldn't send nudge. Try again." });
    } finally {
      setIsSending(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isSending}
      className="bg-(--color-warning) text-white rounded-md px-4 py-2 text-sm font-medium
                 hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {isSending ? "Sending…" : "Send nudge"}
    </button>
  );
}
