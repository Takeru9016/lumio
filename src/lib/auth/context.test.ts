import { describe, expect, it } from "vitest";
import { AuthContextError, requireRole } from "@/lib/auth/context";

/**
 * Phase 19 — the org/roles route tests mock `requireRole` (to isolate route
 * status-code mapping), which means none of them actually exercise its
 * authorization decision. This proves the real, unmocked function denies
 * SUPER_ADMIN for an ORG_ADMIN-only route ("SUPER_ADMIN must be explicitly
 * tested as denied" — not just that the route maps a thrown error to 403).
 */
describe("requireRole", () => {
  it("denies SUPER_ADMIN for an ORG_ADMIN-only allowlist", () => {
    const ctx = { userId: "u1", clerkId: "c1", tenantId: "t1", role: "SUPER_ADMIN" as const };
    expect(() => requireRole(ctx, ["ORG_ADMIN"])).toThrow(AuthContextError);
    try {
      requireRole(ctx, ["ORG_ADMIN"]);
    } catch (err) {
      expect(err).toBeInstanceOf(AuthContextError);
      expect((err as AuthContextError).status).toBe(403);
    }
  });

  it("denies STUDENT and INSTRUCTOR for an ORG_ADMIN-only allowlist", () => {
    for (const role of ["STUDENT", "INSTRUCTOR"] as const) {
      const ctx = { userId: "u1", clerkId: "c1", tenantId: "t1", role };
      expect(() => requireRole(ctx, ["ORG_ADMIN"])).toThrow(AuthContextError);
    }
  });

  it("allows ORG_ADMIN for an ORG_ADMIN-only allowlist", () => {
    const ctx = { userId: "u1", clerkId: "c1", tenantId: "t1", role: "ORG_ADMIN" as const };
    expect(() => requireRole(ctx, ["ORG_ADMIN"])).not.toThrow();
  });
});
