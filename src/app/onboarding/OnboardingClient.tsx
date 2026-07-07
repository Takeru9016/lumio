"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { Role } from "@/generated/prisma/enums";
import { getRoleDashboard } from "@/lib/role-redirect";

const MAX_ATTEMPTS = 10;
const POLL_INTERVAL_MS = 2000;

export function OnboardingClient() {
  const router = useRouter();
  const [timedOut, setTimedOut] = useState(false);
  const attempts = useRef(0);

  useEffect(() => {
    const poll = async () => {
      attempts.current += 1;

      try {
        const res = await fetch("/api/me");
        if (res.ok) {
          const user = (await res.json()) as { role: Role };
          router.replace(getRoleDashboard(user.role));
          return;
        }
      } catch {
        // network error — keep polling
      }

      if (attempts.current >= MAX_ATTEMPTS) {
        setTimedOut(true);
        return;
      }

      setTimeout(poll, POLL_INTERVAL_MS);
    };

    setTimeout(poll, POLL_INTERVAL_MS);
  }, [router]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[#FAFAFA]">
      {timedOut ? (
        <>
          <p className="text-sm text-text-muted">Account setup is taking longer than expected.</p>
          <p className="text-xs text-text-muted">
            Please refresh the page or{" "}
            <a href="/sign-in" className="underline">
              sign in again
            </a>
            .
          </p>
        </>
      ) : (
        <>
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-[#E5E5E7] border-t-[#4F6EF7]" />
          <p className="text-sm text-text-muted">Setting up your account…</p>
        </>
      )}
    </div>
  );
}
