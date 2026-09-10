import { auth } from "@clerk/nextjs/server";

import type { Role } from "@/generated/prisma/enums";
import { db } from "@/lib/db";

/**
 * Authenticated, tenant-scoped identity for the current request. `userId` is
 * the Prisma `User.id` (not the Clerk id) — every domain service should key
 * off this, matching how the rest of the codebase already relates records to
 * `User` (see prisma/schema.prisma). `tenantId` is nullable because not every
 * user belongs to a tenant (e.g. a FREE-plan solo learner).
 *
 * V2 foundation only (docs/V2_MIGRATION_MAP.md, Phase 1) — existing routes
 * are NOT migrated to this yet. They keep their current inline
 * `auth() -> db.user.findUnique -> manual role check` pattern (see e.g.
 * src/app/api/org/branding/route.ts) until a later phase moves them over.
 */
export type AuthContext = {
  userId: string;
  clerkId: string;
  tenantId: string | null;
  role: Role;
};

export class AuthContextError extends Error {
  constructor(
    public status: 401 | 403 | 400,
    message: string
  ) {
    super(message);
    this.name = "AuthContextError";
  }
}

/**
 * Resolves the current Clerk session to an AuthContext. Returns null when
 * there is no signed-in session, or when the Clerk user has no matching
 * `User` row yet (e.g. the Clerk webhook hasn't synced it — see
 * Invitation's doc comment in prisma/schema.prisma for why that can lag).
 */
export async function getAuthContext(): Promise<AuthContext | null> {
  const { userId: clerkId } = await auth();
  if (!clerkId) return null;

  const user = await db.user.findUnique({
    where: { clerkId },
    select: { id: true, tenantId: true, role: true },
  });
  if (!user) return null;

  return {
    userId: user.id,
    clerkId,
    tenantId: user.tenantId,
    role: user.role,
  };
}

/** Same as getAuthContext, but throws AuthContextError(401) instead of returning null. */
export async function requireAuthContext(): Promise<AuthContext> {
  const ctx = await getAuthContext();
  if (!ctx) throw new AuthContextError(401, "Unauthorized");
  return ctx;
}

/** Narrows ctx.tenantId to string, or throws AuthContextError(400). */
export function requireTenant(ctx: AuthContext): asserts ctx is AuthContext & { tenantId: string } {
  if (!ctx.tenantId) throw new AuthContextError(400, "No organisation found");
}

/** Throws AuthContextError(403) if ctx.role is not one of `roles`. */
export function requireRole(ctx: AuthContext, roles: Role[]): void {
  if (!roles.includes(ctx.role)) throw new AuthContextError(403, "Forbidden");
}
