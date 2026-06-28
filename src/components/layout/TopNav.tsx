"use client";

import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { Bell } from "lucide-react";

import { AiBadge } from "@/components/shared/AiBadge";

interface TopNavProps {
  showAiBadge?: boolean;
}

export function TopNav({ showAiBadge = false }: TopNavProps) {
  return (
    <header
      className="h-[52px] flex items-center justify-between px-4 bg-white shrink-0"
      style={{ borderBottom: "0.5px solid var(--color-border)" }}
    >
      <Link
        href="/"
        className="font-bold text-brand text-xl tracking-tight"
        style={{ fontFamily: "var(--font-heading)" }}
      >
        Lumio
      </Link>

      <div className="flex items-center gap-3">
        {showAiBadge && (
          <Link href="/ai-tutor">
            <AiBadge label="AI Tutor" size="md" />
          </Link>
        )}

        <button
          aria-label="Notifications"
          className="p-1.5 text-text-muted hover:text-text-primary hover:bg-surface-2 rounded-md transition-colors"
        >
          <Bell size={18} />
        </button>

        <UserButton />
      </div>
    </header>
  );
}
