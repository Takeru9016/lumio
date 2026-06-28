"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const MAX_ATTEMPTS = 10;
const POLL_INTERVAL_MS = 2000;

export default function OnboardingPage() {
  const router = useRouter();
  const [timedOut, setTimedOut] = useState(false);
  const attempts = useRef(0);

  useEffect(() => {
    const poll = async () => {
      attempts.current += 1;

      try {
        const res = await fetch("/api/me");
        if (res.ok) {
          router.replace("/dashboard");
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
          <p className="text-sm text-[#737380]">
            Account setup is taking longer than expected.
          </p>
          <p className="text-xs text-[#737380]">
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
          <p className="text-sm text-[#737380]">Setting up your account…</p>
        </>
      )}
    </div>
  );
}
