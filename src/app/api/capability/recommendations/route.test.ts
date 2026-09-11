import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level test for GET /api/capability/recommendations. There is no
 * Clerk-mock harness anywhere in this repo (verified — no `vi.mock` of
 * `@clerk/nextjs/server` exists; the established pattern, e.g.
 * saveDraft.test.ts, tests AuthContextError at the domain-function level
 * with a hand-built ctx, never by invoking a route handler). This file
 * follows the repo's one existing route-adjacent mocking pattern instead
 * (generate.test.ts's `vi.mock` + `vi.importActual` of a single module),
 * applied to `@/lib/auth/context` and `@/lib/domain/capability/recommendations`
 * — not Clerk itself, and not a new framework. This is deliberately the
 * smallest mock that lets the route's OWN logic (status mapping, response
 * shape, query-string isolation) run for real.
 */
vi.mock("@/lib/auth/context", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/context")>("@/lib/auth/context");
  return { ...actual, requireAuthContext: vi.fn(), requireTenant: vi.fn() };
});

vi.mock("@/lib/domain/capability/recommendations", () => ({
  getRecommendedLearning: vi.fn(),
}));

const { AuthContextError, requireAuthContext, requireTenant } = await import("@/lib/auth/context");
const { getRecommendedLearning } = await import("@/lib/domain/capability/recommendations");
const { GET } = await import("./route");

const requireAuthContextMock = vi.mocked(requireAuthContext);
const requireTenantMock = vi.mocked(requireTenant);
const req = () => new Request("http://localhost/api/capability/recommendations");
const getRecommendedLearningMock = vi.mocked(getRecommendedLearning);

afterEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/capability/recommendations", () => {
  it("unauthenticated -> 401", async () => {
    requireAuthContextMock.mockRejectedValue(new AuthContextError(401, "Unauthorized"));

    const res = await GET(req());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("authenticated without a tenant -> 400, matching requireTenant's actual behavior (not the architecture doc's placeholder 403)", async () => {
    requireAuthContextMock.mockResolvedValue({
      userId: "u1",
      clerkId: "c1",
      tenantId: null,
      role: "STUDENT",
    });
    requireTenantMock.mockImplementation(() => {
      throw new AuthContextError(400, "No organisation found");
    });

    const res = await GET(req());

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "No organisation found" });
  });

  it("query-string userId/tenantId are ignored -- getRecommendedLearning is called with only the authenticated ctx", async () => {
    requireAuthContextMock.mockResolvedValue({
      userId: "real-user",
      clerkId: "c1",
      tenantId: "real-tenant",
      role: "STUDENT",
    });
    requireTenantMock.mockImplementation(() => {});
    getRecommendedLearningMock.mockResolvedValue({ recommendations: [] });

    // The route ignores its request argument entirely (it never reads
    // searchParams) — passing a crafted URL proves query-string identity
    // overrides are structurally impossible, not merely untested.
    await GET(
      new Request(
        "http://localhost/api/capability/recommendations?userId=someone-else&tenantId=other-tenant"
      )
    );

    expect(getRecommendedLearningMock).toHaveBeenCalledWith({
      userId: "real-user",
      clerkId: "c1",
      tenantId: "real-tenant",
      role: "STUDENT",
    });
  });

  it("success response shape contains only courseId/courseTitle/reasonSkills -- internal courseSlug is never exposed", async () => {
    requireAuthContextMock.mockResolvedValue({
      userId: "u1",
      clerkId: "c1",
      tenantId: "t1",
      role: "STUDENT",
    });
    requireTenantMock.mockImplementation(() => {});
    getRecommendedLearningMock.mockResolvedValue({
      recommendations: [
        {
          courseId: "c1",
          courseTitle: "Course 1",
          courseSlug: "course-1-slug",
          reasonSkills: [
            {
              skillId: "s1",
              skillName: "Skill 1",
              requiredProficiency: "BEGINNER",
              currentProficiency: "NONE",
            },
          ],
        },
      ],
    });

    const res = await GET(req());
    const body = await res.json();

    expect(body).toEqual({
      recommendations: [
        {
          courseId: "c1",
          courseTitle: "Course 1",
          reasonSkills: [
            {
              skillId: "s1",
              skillName: "Skill 1",
              requiredProficiency: "BEGINNER",
              currentProficiency: "NONE",
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("course-1-slug");
    expect(JSON.stringify(body)).not.toContain("courseSlug");
  });

  it("empty recommendations -> 200 with an empty array, not an error", async () => {
    requireAuthContextMock.mockResolvedValue({
      userId: "u1",
      clerkId: "c1",
      tenantId: "t1",
      role: "STUDENT",
    });
    requireTenantMock.mockImplementation(() => {});
    getRecommendedLearningMock.mockResolvedValue({ recommendations: [] });

    const res = await GET(req());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recommendations: [] });
  });

  it("internal failure -> 500 with a generic message, no internal detail leaked", async () => {
    requireAuthContextMock.mockResolvedValue({
      userId: "u1",
      clerkId: "c1",
      tenantId: "t1",
      role: "STUDENT",
    });
    requireTenantMock.mockImplementation(() => {});
    getRecommendedLearningMock.mockRejectedValue(
      new Error("db connection string leaked: postgres://secret@host/db")
    );

    const res = await GET(req());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: "Failed to compute recommendations" });
    expect(JSON.stringify(body)).not.toContain("postgres://secret");
  });
});
