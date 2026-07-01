import type { Ratelimit } from "@upstash/ratelimit";
import { db } from "@/lib/db";
import { checkAndIncrementQuota } from "@/lib/ai/quota";

type User = NonNullable<Awaited<ReturnType<typeof db.user.findUnique>>>;

type GuardResult =
  | { ok: true; user: User }
  | { ok: false; response: Response };

/**
 * Guards every /api/ai/* route in order:
 * 1. auth (userId present)
 * 2. rate limit (Upstash sliding window)
 * 3. plan quota (DB) — atomically increments usage when allowed
 *
 * Returns { ok: true, user } to proceed, or { ok: false, response } to short-circuit.
 */
export async function withAiGuards(
  userId: string | null | undefined,
  limiter: Ratelimit,
): Promise<GuardResult> {
  if (!userId) {
    return {
      ok: false,
      response: new Response("Unauthorized", { status: 401 }),
    };
  }

  const { success } = await limiter.limit(userId);
  if (!success) {
    return {
      ok: false,
      response: Response.json(
        { error: "Rate limit exceeded" },
        { status: 429 },
      ),
    };
  }

  const user = await db.user.findUnique({ where: { clerkId: userId } });
  if (!user) {
    return {
      ok: false,
      response: new Response("User not found", { status: 404 }),
    };
  }

  const { allowed } = await checkAndIncrementQuota(userId, user.plan);
  if (!allowed) {
    return {
      ok: false,
      response: Response.json(
        { error: "AI quota exceeded", upgradeRequired: true },
        { status: 403 },
      ),
    };
  }

  return { ok: true, user };
}
