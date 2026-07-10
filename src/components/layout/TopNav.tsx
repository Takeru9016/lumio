"use client";

import { UserButton } from "@clerk/nextjs";
import Link from "next/link";

import { NotificationBell } from "@/components/layout/NotificationBell";
import { AiBadge } from "@/components/shared/AiBadge";

interface TopNavProps {
  showAiBadge?: boolean;
  currentStreak?: number;
  logoUrl?: string | null;
  initialUnreadCount?: number;
}

export function TopNav({
  showAiBadge = false,
  currentStreak = 0,
  logoUrl = null,
  initialUnreadCount = 0,
}: TopNavProps) {
  return (
    <header
      className="h-[52px] flex items-center justify-between px-4 bg-white shrink-0"
      style={{ borderBottom: "0.5px solid var(--color-border)" }}
    >
      <Link href="/" className="flex items-center">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt="Organisation logo" className="h-7 w-auto" />
        ) : (
          <span
            className="font-bold text-brand text-xl tracking-tight"
            style={{ fontFamily: "var(--font-heading)" }}
          >
            Lumio
          </span>
        )}
      </Link>

      <div className="flex items-center gap-3">
        {showAiBadge && (
          <Link href="/ai-tutor">
            <AiBadge label="AI Tutor" size="md" />
          </Link>
        )}

        {currentStreak >= 2 && (
          <span className="text-sm font-medium text-text-muted">🔥 {currentStreak}-day</span>
        )}

        <NotificationBell initialUnreadCount={initialUnreadCount} />

        <UserButton />
      </div>
    </header>
  );
}
