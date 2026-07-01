"use client";

import MuxPlayer from "@mux/mux-player-react";

interface VideoPlayerProps {
  playbackId: string;
  videoStatus?: "PENDING" | "PROCESSING" | "READY" | "ERROR";
  onProgress?: (pct: number) => void;
  onComplete?: () => void;
}

export function VideoPlayer({
  playbackId,
  videoStatus = "READY",
  onProgress,
  onComplete,
}: VideoPlayerProps) {
  if (videoStatus !== "READY") {
    return <div className="w-full aspect-video rounded-lg bg-neutral-900 animate-pulse" />;
  }

  return (
    <MuxPlayer
      playbackId={playbackId}
      className="w-full aspect-video rounded-lg bg-black"
      onTimeUpdate={(e) => {
        const target = e.target as HTMLVideoElement;
        if (!target.duration) return;
        const pct = target.currentTime / target.duration;
        onProgress?.(pct);
        if (pct >= 0.9) {
          onComplete?.();
        }
      }}
    />
  );
}
