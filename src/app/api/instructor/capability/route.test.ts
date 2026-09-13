import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level test for GET /api/instructor/capability, mirroring
 * org/capability/route.test.ts's (Phase 9) vi.mock(@/lib/auth/context) +
 * vi.mock(domain module) pattern.
 */
vi.mock("@/lib/auth/context", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/context")>("@/lib/auth/context");
  return { ...actual, requireAuthContext: vi.fn(), requireTenant: vi.fn(), requireRole: vi.fn() };
});

vi.mock("@/lib/domain/capability/instructorReport", async () => {
  const actual = await vi.importActual<typeof import("@/lib/domain/capability/instructorReport")>(
    "@/lib/domain/capability/instructorReport"
  );
  return {
    InstructorCapabilityCursorError: actual.InstructorCapabilityCursorError,
    getInstructorCapabilityReport: vi.fn(),
  };
});

const { AuthContextError, requireAuthContext, requireTenant, requireRole } = await import(
  "@/lib/auth/context"
);
const { getInstructorCapabilityReport, InstructorCapabilityCursorError } = await import(
  "@/lib/domain/capability/instructorReport"
);
const { GET } = await import("./route");

const requireAuthContextMock = vi.mocked(requireAuthContext);
const requireTenantMock = vi.mocked(requireTenant);
const requireRoleMock = vi.mocked(requireRole);
const getReportMock = vi.mocked(getInstructorCapabilityReport);
const req = (qs = "") => new Request(`http://localhost/api/instructor/capability${qs}`);

function mockAuthed(role: "STUDENT" | "INSTRUCTOR" | "ORG_ADMIN" | "SUPER_ADMIN") {
  requireAuthContextMock.mockResolvedValue({
    userId: "u1",
    clerkId: "c1",
    tenantId: "t1",
    role,
  });
  requireTenantMock.mockImplementation(() => {});
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/instructor/capability", () => {
  it("unauthenticated -> 401", async () => {
    requireAuthContextMock.mockRejectedValue(new AuthContextError(401, "Unauthorized"));

    const res = await GET(req());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("no tenant -> 400", async () => {
    requireAuthContextMock.mockResolvedValue({
      userId: "u1",
      clerkId: "c1",
      tenantId: null,
      role: "INSTRUCTOR",
    });
    requireTenantMock.mockImplementation(() => {
      throw new AuthContextError(400, "No organisation found");
    });

    const res = await GET(req());

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "No organisation found" });
  });

  it("STUDENT -> 403", async () => {
    mockAuthed("STUDENT");
    requireRoleMock.mockImplementation(() => {
      throw new AuthContextError(403, "Forbidden");
    });

    const res = await GET(req());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("ORG_ADMIN -> 403", async () => {
    mockAuthed("ORG_ADMIN");
    requireRoleMock.mockImplementation(() => {
      throw new AuthContextError(403, "Forbidden");
    });

    const res = await GET(req());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("SUPER_ADMIN -> 403", async () => {
    mockAuthed("SUPER_ADMIN");
    requireRoleMock.mockImplementation(() => {
      throw new AuthContextError(403, "Forbidden");
    });

    const res = await GET(req());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("INSTRUCTOR -> 200, instructor and tenant taken only from the authenticated ctx", async () => {
    mockAuthed("INSTRUCTOR");
    requireRoleMock.mockImplementation(() => {});
    getReportMock.mockResolvedValue({ learners: [], nextCursor: null });

    // instructorId/tenantId in the query string must never override the authenticated ones.
    const res = await GET(req("?instructorId=someone-elses-id&tenantId=someone-elses-tenant"));

    expect(res.status).toBe(200);
    expect(getReportMock).toHaveBeenCalledWith("u1", "t1", { cursor: undefined, limit: undefined });
  });

  it("passes cursor/limit query params through to the domain function", async () => {
    mockAuthed("INSTRUCTOR");
    requireRoleMock.mockImplementation(() => {});
    getReportMock.mockResolvedValue({ learners: [], nextCursor: null });

    await GET(req("?cursor=abc123&limit=10"));

    expect(getReportMock).toHaveBeenCalledWith("u1", "t1", { cursor: "abc123", limit: 10 });
  });

  it("limit above 100 -> 400", async () => {
    mockAuthed("INSTRUCTOR");
    requireRoleMock.mockImplementation(() => {});

    const res = await GET(req("?limit=101"));

    expect(res.status).toBe(400);
    expect(getReportMock).not.toHaveBeenCalled();
  });

  it("non-integer limit -> 400", async () => {
    mockAuthed("INSTRUCTOR");
    requireRoleMock.mockImplementation(() => {});

    const res = await GET(req("?limit=abc"));

    expect(res.status).toBe(400);
  });

  it("invalid cursor surfaced by the domain function -> 400", async () => {
    mockAuthed("INSTRUCTOR");
    requireRoleMock.mockImplementation(() => {});
    getReportMock.mockRejectedValue(new InstructorCapabilityCursorError());

    const res = await GET(req("?cursor=garbage"));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid cursor" });
  });

  it("success response shape is exactly { learners, nextCursor }", async () => {
    mockAuthed("INSTRUCTOR");
    requireRoleMock.mockImplementation(() => {});
    getReportMock.mockResolvedValue({
      learners: [
        {
          userId: "u2",
          name: "Learner Two",
          roleId: "r1",
          roleName: "Sales Rep",
          skills: [
            {
              skillId: "s1",
              skillName: "Negotiation",
              required: "BEGINNER",
              current: "NONE",
              met: false,
            },
          ],
        },
      ],
      nextCursor: "opaque-cursor",
    });

    const res = await GET(req());
    const body = await res.json();

    expect(body).toEqual({
      learners: [
        {
          userId: "u2",
          name: "Learner Two",
          roleId: "r1",
          roleName: "Sales Rep",
          skills: [
            {
              skillId: "s1",
              skillName: "Negotiation",
              required: "BEGINNER",
              current: "NONE",
              met: false,
            },
          ],
        },
      ],
      nextCursor: "opaque-cursor",
    });
  });

  it("internal failure -> 500 with a generic message, no internal detail leaked", async () => {
    mockAuthed("INSTRUCTOR");
    requireRoleMock.mockImplementation(() => {});
    getReportMock.mockRejectedValue(
      new Error("db connection string leaked: postgres://secret@host/db")
    );

    const res = await GET(req());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: "Failed to load capability report" });
    expect(JSON.stringify(body)).not.toContain("postgres://secret");
  });
});
