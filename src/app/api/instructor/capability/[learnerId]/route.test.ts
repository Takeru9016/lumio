import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level test for GET /api/instructor/capability/[learnerId] (Phase
 * 21), mirroring ../route.test.ts's (Phase 11) vi.mock(@/lib/auth/context) +
 * vi.mock(domain module) pattern.
 */
vi.mock("@/lib/auth/context", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/context")>("@/lib/auth/context");
  return { ...actual, requireAuthContext: vi.fn(), requireTenant: vi.fn(), requireRole: vi.fn() };
});

vi.mock("@/lib/domain/capability/instructorReport", () => ({
  getInstructorLearnerRoles: vi.fn(),
  getInstructorCapabilityForLearnerRole: vi.fn(),
}));

const { AuthContextError, requireAuthContext, requireTenant, requireRole } = await import(
  "@/lib/auth/context"
);
const { getInstructorLearnerRoles, getInstructorCapabilityForLearnerRole } = await import(
  "@/lib/domain/capability/instructorReport"
);
const { GET } = await import("./route");

const requireAuthContextMock = vi.mocked(requireAuthContext);
const requireTenantMock = vi.mocked(requireTenant);
const requireRoleMock = vi.mocked(requireRole);
const getInstructorLearnerRolesMock = vi.mocked(getInstructorLearnerRoles);
const getInstructorCapabilityForLearnerRoleMock = vi.mocked(getInstructorCapabilityForLearnerRole);

const req = (learnerId: string, qs = "") =>
  GET(new Request(`http://localhost/api/instructor/capability/${learnerId}${qs}`), {
    params: Promise.resolve({ learnerId }),
  });

function mockAuthed(role: "STUDENT" | "INSTRUCTOR" | "ORG_ADMIN" | "SUPER_ADMIN") {
  requireAuthContextMock.mockResolvedValue({ userId: "u1", clerkId: "c1", tenantId: "t1", role });
  requireTenantMock.mockImplementation(() => {});
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/instructor/capability/[learnerId] — authentication & authorization", () => {
  it("unauthenticated -> 401", async () => {
    requireAuthContextMock.mockRejectedValue(new AuthContextError(401, "Unauthorized"));

    const res = await req("learner1");

    expect(res.status).toBe(401);
  });

  it("STUDENT -> 403, never reaches the domain function", async () => {
    mockAuthed("STUDENT");
    requireRoleMock.mockImplementation(() => {
      throw new AuthContextError(403, "Forbidden");
    });

    const res = await req("learner1");

    expect(res.status).toBe(403);
    expect(getInstructorLearnerRolesMock).not.toHaveBeenCalled();
  });

  it("ORG_ADMIN -> 403", async () => {
    mockAuthed("ORG_ADMIN");
    requireRoleMock.mockImplementation(() => {
      throw new AuthContextError(403, "Forbidden");
    });

    const res = await req("learner1");

    expect(res.status).toBe(403);
  });
});

describe("GET /api/instructor/capability/[learnerId] — not this instructor's student", () => {
  it("getInstructorLearnerRoles returning null -> 404", async () => {
    mockAuthed("INSTRUCTOR");
    requireRoleMock.mockImplementation(() => {});
    getInstructorLearnerRolesMock.mockResolvedValue(null);

    const res = await req("not-my-student");
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ error: "Learner not found" });
    expect(getInstructorCapabilityForLearnerRoleMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/instructor/capability/[learnerId] — role resolution", () => {
  it("no roleId query param -> defaults to the learner's primary role", async () => {
    mockAuthed("INSTRUCTOR");
    requireRoleMock.mockImplementation(() => {});
    getInstructorLearnerRolesMock.mockResolvedValue([
      { roleId: "r1", roleName: "Role A", isPrimary: true },
      { roleId: "r2", roleName: "Role B", isPrimary: false },
    ]);
    getInstructorCapabilityForLearnerRoleMock.mockResolvedValue({
      userId: "learner1",
      name: "Learner One",
      roleId: "r1",
      roleName: "Role A",
      hasMultipleRoles: true,
      skills: [],
    });

    const res = await req("learner1");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(getInstructorCapabilityForLearnerRoleMock).toHaveBeenCalledWith(
      "u1",
      "t1",
      "learner1",
      "r1"
    );
    expect(body.learner.roleId).toBe("r1");
  });

  it("a valid roleId the learner holds -> that role's data", async () => {
    mockAuthed("INSTRUCTOR");
    requireRoleMock.mockImplementation(() => {});
    getInstructorLearnerRolesMock.mockResolvedValue([
      { roleId: "r1", roleName: "Role A", isPrimary: true },
      { roleId: "r2", roleName: "Role B", isPrimary: false },
    ]);
    getInstructorCapabilityForLearnerRoleMock.mockResolvedValue({
      userId: "learner1",
      name: "Learner One",
      roleId: "r2",
      roleName: "Role B",
      hasMultipleRoles: true,
      skills: [],
    });

    const res = await req("learner1", "?roleId=r2");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(getInstructorCapabilityForLearnerRoleMock).toHaveBeenCalledWith(
      "u1",
      "t1",
      "learner1",
      "r2"
    );
    expect(body.learner.roleId).toBe("r2");
  });

  it("an invalid/unheld roleId falls back to primary (not 403/400) — the response's learner.roleId pins which role was actually used", async () => {
    mockAuthed("INSTRUCTOR");
    requireRoleMock.mockImplementation(() => {});
    getInstructorLearnerRolesMock.mockResolvedValue([
      { roleId: "r1", roleName: "Role A", isPrimary: true },
      { roleId: "r2", roleName: "Role B", isPrimary: false },
    ]);
    getInstructorCapabilityForLearnerRoleMock.mockResolvedValue({
      userId: "learner1",
      name: "Learner One",
      roleId: "r1",
      roleName: "Role A",
      hasMultipleRoles: true,
      skills: [],
    });

    const res = await req("learner1", "?roleId=not-held-by-this-learner");
    const body = await res.json();

    // Silent fallback, not an error — this route's roleId comes from a
    // dropdown the client only ever populates from this same route's own
    // `roles` response, so a mismatch here means a stale/rewritten request,
    // not a real user action (see the Phase 21 report's Deviations section).
    expect(res.status).toBe(200);
    expect(getInstructorCapabilityForLearnerRoleMock).toHaveBeenCalledWith(
      "u1",
      "t1",
      "learner1",
      "r1"
    );
    expect(body.learner.roleId).toBe("r1");
  });

  it("a learner with zero roles -> 200 with an empty roles array and a null learner, never calls getInstructorCapabilityForLearnerRole", async () => {
    mockAuthed("INSTRUCTOR");
    requireRoleMock.mockImplementation(() => {});
    getInstructorLearnerRolesMock.mockResolvedValue([]);

    const res = await req("learner-no-roles");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ roles: [], learner: null });
    expect(getInstructorCapabilityForLearnerRoleMock).not.toHaveBeenCalled();
  });
});
