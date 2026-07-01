"use client";

import { Flame, Trophy } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";

export type LeaderboardEntry = {
  id: string;
  name: string | null;
  avatarUrl: string | null;
  currentStreak: number;
  xp: number;
  rank: number;
};

export type LeaderboardData = {
  entries: LeaderboardEntry[];
  currentUserEntry: LeaderboardEntry | null;
};

type Props = {
  currentUserId: string;
  hasTenant: boolean;
  weeklyPlatform: LeaderboardData;
  alltimePlatform: LeaderboardData;
  weeklyOrg?: LeaderboardData;
  alltimeOrg?: LeaderboardData;
};

const MEDAL: Record<number, string> = { 1: "🥇", 2: "🥈", 3: "🥉" };

const listVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.05 } },
};

const rowVariants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.2, ease: "easeOut" as const } },
};

export function LeaderboardClient({
  currentUserId,
  hasTenant,
  weeklyPlatform,
  alltimePlatform,
  weeklyOrg,
  alltimeOrg,
}: Props) {
  const [period, setPeriod] = useState<"weekly" | "alltime">("weekly");
  const [scope, setScope] = useState<"platform" | "org">("platform");

  const current =
    period === "weekly"
      ? scope === "org"
        ? (weeklyOrg ?? weeklyPlatform)
        : weeklyPlatform
      : scope === "org"
        ? (alltimeOrg ?? alltimePlatform)
        : alltimePlatform;

  const { entries, currentUserEntry } = current;
  const isCurrentUserInList = entries.some((e) => e.id === currentUserId);
  const extraRow = !isCurrentUserInList && currentUserEntry ? currentUserEntry : null;

  return (
    <div className="space-y-4">
      {/* Toggles */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center bg-surface-3 rounded-md p-0.5 text-sm">
          {(["weekly", "alltime"] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriod(p)}
              className={`px-3 py-1.5 rounded font-medium transition-colors ${
                period === p
                  ? "bg-white text-text-primary shadow-sm"
                  : "text-text-muted hover:text-text-primary"
              }`}
            >
              {p === "weekly" ? "Weekly" : "All-Time"}
            </button>
          ))}
        </div>

        {hasTenant && (
          <div className="flex items-center bg-surface-3 rounded-md p-0.5 text-sm">
            {(["platform", "org"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setScope(s)}
                className={`px-3 py-1.5 rounded font-medium transition-colors ${
                  scope === s
                    ? "bg-white text-text-primary shadow-sm"
                    : "text-text-muted hover:text-text-primary"
                }`}
              >
                {s === "platform" ? "Platform" : "My Org"}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Table */}
      <div className="bg-white border border-border rounded-lg overflow-hidden shadow-sm">
        {/* Header row */}
        <div className="grid grid-cols-[48px_1fr_80px_72px] px-4 py-2.5 border-b border-border bg-surface-2">
          <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">#</span>
          <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">
            Student
          </span>
          <span className="text-xs font-semibold text-text-muted uppercase tracking-wide text-right">
            XP
          </span>
          <span className="text-xs font-semibold text-text-muted uppercase tracking-wide text-right">
            Streak
          </span>
        </div>

        {entries.length === 0 ? (
          <div className="py-16 text-center">
            <Trophy size={28} className="text-text-disabled mx-auto mb-2" />
            <p className="text-sm font-medium text-text-primary">No activity yet</p>
            <p className="text-xs text-text-muted mt-1">
              Complete lessons to earn XP and appear here.
            </p>
          </div>
        ) : (
          <motion.div
            key={`${period}-${scope}`}
            variants={listVariants}
            initial="hidden"
            animate="visible"
          >
            {entries.map((entry) => (
              <LeaderboardRow
                key={entry.id}
                entry={entry}
                isCurrentUser={entry.id === currentUserId}
              />
            ))}
          </motion.div>
        )}

        {/* Current user outside top 50 */}
        {extraRow && (
          <div className="border-t border-dashed border-border">
            <LeaderboardRow entry={extraRow} isCurrentUser isDivider />
          </div>
        )}
      </div>
    </div>
  );
}

function LeaderboardRow({
  entry,
  isCurrentUser,
  isDivider = false,
}: {
  entry: LeaderboardEntry;
  isCurrentUser: boolean;
  isDivider?: boolean;
}) {
  const initials = (entry.name ?? "?")[0].toUpperCase();
  const medal = MEDAL[entry.rank];

  return (
    <motion.div
      variants={isDivider ? undefined : rowVariants}
      className={`grid grid-cols-[48px_1fr_80px_72px] items-center px-4 py-3 border-b border-border last:border-0 transition-colors ${
        isCurrentUser
          ? "border-l-2 border-l-[var(--color-brand)] bg-[var(--color-brand-light)]"
          : "hover:bg-surface-2"
      }`}
    >
      {/* Rank */}
      <div className="flex items-center">
        {medal ? (
          <span className="text-base leading-none">{medal}</span>
        ) : (
          <span className="text-sm font-semibold text-text-muted tabular-nums">{entry.rank}</span>
        )}
      </div>

      {/* Avatar + Name */}
      <div className="flex items-center gap-2.5 min-w-0">
        {entry.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={entry.avatarUrl}
            alt={entry.name ?? "Avatar"}
            width={28}
            height={28}
            className="w-7 h-7 rounded-full object-cover shrink-0"
          />
        ) : (
          <div className="w-7 h-7 rounded-full bg-surface-3 flex items-center justify-center text-xs font-semibold text-text-muted shrink-0">
            {initials}
          </div>
        )}
        <span
          className={`text-sm truncate ${
            isCurrentUser ? "font-semibold text-[var(--color-brand)]" : "text-text-primary"
          }`}
        >
          {entry.name ?? "Unknown"}
          {isCurrentUser && (
            <span className="ml-1.5 text-xs font-normal text-[var(--color-brand)]">(you)</span>
          )}
        </span>
      </div>

      {/* XP */}
      <div className="text-right">
        <span className="text-sm font-semibold text-text-primary tabular-nums">
          {entry.xp.toLocaleString()}
        </span>
        <span className="text-xs text-text-muted ml-0.5">xp</span>
      </div>

      {/* Streak */}
      <div className="flex items-center justify-end gap-1">
        <Flame
          size={12}
          className={entry.currentStreak > 0 ? "text-warning" : "text-text-disabled"}
        />
        <span className="text-sm tabular-nums text-text-secondary">{entry.currentStreak}</span>
      </div>
    </motion.div>
  );
}
