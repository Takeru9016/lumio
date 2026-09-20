"use client";

import { UserButton } from "@clerk/nextjs";
import Link from "next/link";

import { MobileNav } from "@/components/layout/MobileNav";
import { NotificationBell } from "@/components/layout/NotificationBell";
import { AiBadge } from "@/components/shared/AiBadge";
import type { Role } from "@/types";

interface TopNavProps {
  showAiBadge?: boolean;
  currentStreak?: number;
  logoUrl?: string | null;
  initialUnreadCount?: number;
  /** When set, a menu button appears below `md`, where the sidebar is hidden. */
  navRole?: Role;
}

export function TopNav({
  showAiBadge = false,
  currentStreak = 0,
  logoUrl = null,
  initialUnreadCount = 0,
  navRole,
}: TopNavProps) {
  return (
    <header
      className="h-13 flex items-center justify-between px-4 bg-white shrink-0"
      style={{ borderBottom: "0.5px solid var(--color-border)" }}
    >
      <div className="flex items-center gap-1">
        {navRole && <MobileNav role={navRole} />}
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
      </div>

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
