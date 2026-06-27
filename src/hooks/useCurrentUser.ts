"use client";

import { useUser } from "@clerk/nextjs";
import { useEffect, useState } from "react";

type DbUser = {
  id: string;
  clerkId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  role: "STUDENT" | "INSTRUCTOR" | "ORG_ADMIN" | "SUPER_ADMIN";
  plan: "FREE" | "STARTER" | "PRO" | "ENTERPRISE";
  aiCallsUsed: number;
  aiQuotaResetAt: string;
  xpTotal: number;
  currentStreak: number;
  longestStreak: number;
  tenantId: string | null;
  createdAt: string;
};

export function useCurrentUser() {
  const { user: clerkUser, isLoaded, isSignedIn } = useUser();
  const [dbUser, setDbUser] = useState<DbUser | null>(null);
  const [isDbLoading, setIsDbLoading] = useState(false);
  const [dbError, setDbError] = useState<Error | null>(null);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;

    setIsDbLoading(true);
    fetch("/api/me")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch user");
        return res.json() as Promise<DbUser>;
      })
      .then(setDbUser)
      .catch(setDbError)
      .finally(() => setIsDbLoading(false));
  }, [isLoaded, isSignedIn]);

  return {
    clerkUser,
    dbUser,
    isLoaded,
    isSignedIn,
    isDbLoading,
    dbError,
  };
}
