"use client";

import { LoadErrorPanel } from "@/components/learning-path/LoadErrorPanel";

export default function OrgPathsError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <LoadErrorPanel
        title="Couldn't load learning paths"
        message="Something went wrong on this page. Try again in a moment."
        onRetry={reset}
      />
    </div>
  );
}
