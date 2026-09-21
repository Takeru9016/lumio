import type { PathWorld } from "@/lib/domain/learning-path/__test__/pathWorld";

/**
 * Everyone an admin path route must turn away, with the status the org admin
 * routes answer them with: no session and a session with no Lumio user are 401, a
 * student, an instructor and a super admin are 403, and an ORG_ADMIN who belongs to
 * no organisation is 400 "No organisation found".
 */
export function refusals(w: PathWorld): [string, string | null, number][] {
  return [
    ["unauthenticated", null, 401],
    ["a Clerk user with no Lumio row", "clerk_never_synced", 401],
    ["STUDENT", w.learner.user.clerkId, 403],
    ["INSTRUCTOR", w.instructor.user.clerkId, 403],
    ["SUPER_ADMIN", w.superAdmin.user.clerkId, 403],
    ["ORG_ADMIN with no tenant", w.tenantlessAdmin.clerkId, 400],
  ];
}

export const jsonRequest = (url: string, method: string, body?: unknown, raw = false) =>
  new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: raw ? (body as string) : JSON.stringify(body) }),
  });
