import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/context", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/context")>("@/lib/auth/context");
  return { ...actual, requireAuthContext: vi.fn(), requireTenant: vi.fn(), requireRole: vi.fn() };
});

vi.mock("@/lib/domain/capability/history", async () => {
  const actual = await vi.importActual<typeof import("@/lib/domain/capability/history")>(
    "@/lib/domain/capability/history"
  );
  return {
    HistoryCursorError: actual.HistoryCursorError,
    MAX_LIMIT: actual.MAX_LIMIT,
    getInstructorLearnerHistory: vi.fn(),
  };
});

const { AuthContextError, requireAuthContext, requireTenant, requireRole } = await import(
  "@/lib/auth/context"
);
const { getInstructorLearnerHistory, HistoryCursorError } = await import(
  "@/lib/domain/capability/history"
);
const { GET } = await import("./route");

const requireAuthContextMock = vi.mocked(requireAuthContext);
const requireTenantMock = vi.mocked(requireTenant);
const requireRoleMock = vi.mocked(requireRole);
const getHistoryMock = vi.mocked(getInstructorLearnerHistory);

const req = (qs = "") =>
  new Request(`http://localhost/api/instructor/capability/learner-1/history${qs}`);
const params = { params: Promise.resolve({ learnerId: "learner-1" }) };

function mockAuthed(role: "STUDENT" | "INSTRUCTOR" | "ORG_ADMIN" | "SUPER_ADMIN" = "INSTRUCTOR") {
  requireAuthContextMock.mockResolvedValue({ userId: "u1", clerkId: "c1", tenantId: "t1", role });
  requireTenantMock.mockImplementation(() => {});
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/instructor/capability/[learnerId]/history", () => {
  it("unauthenticated -> 401", async () => {
    requireAuthContextMock.mockRejectedValue(new AuthContextError(401, "Unauthorized"));
    const res = await GET(req(), params);
    expect(res.status).toBe(401);
  });

  it("STUDENT -> 403", async () => {
    mockAuthed("STUDENT");
    requireRoleMock.mockImplementation(() => {
      throw new AuthContextError(403, "Forbidden");
    });
    const res = await GET(req(), params);
    expect(res.status).toBe(403);
  });

  it("ORG_ADMIN -> 403 (this route is INSTRUCTOR-only)", async () => {
    mockAuthed("ORG_ADMIN");
    requireRoleMock.mockImplementation(() => {
      throw new AuthContextError(403, "Forbidden");
    });
    const res = await GET(req(), params);
    expect(res.status).toBe(403);
  });

  it("authorized instructor -> 200", async () => {
    mockAuthed("INSTRUCTOR");
    requireRoleMock.mockImplementation(() => {});
    getHistoryMock.mockResolvedValue({ items: [], nextCursor: null });

    const res = await GET(req(), params);

    expect(res.status).toBe(200);
    expect(getHistoryMock).toHaveBeenCalledWith(
      { userId: "u1", clerkId: "c1", tenantId: "t1", role: "INSTRUCTOR" },
      "learner-1",
      {
        skillId: undefined,
        type: undefined,
        from: undefined,
        to: undefined,
        evidenceId: undefined,
      },
      { cursor: undefined, limit: undefined }
    );
  });

  it("domain function returns null (not authorized / not found / soft-deleted) -> 404", async () => {
    mockAuthed("INSTRUCTOR");
    requireRoleMock.mockImplementation(() => {});
    getHistoryMock.mockResolvedValue(null);

    const res = await GET(req(), params);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Learner not found" });
  });

  it("passes evidenceId filter through", async () => {
    mockAuthed("INSTRUCTOR");
    requireRoleMock.mockImplementation(() => {});
    getHistoryMock.mockResolvedValue({ items: [], nextCursor: null });

    await GET(req("?evidenceId=ev1&type=EVIDENCE_STANDING_CHANGED"), params);

    expect(getHistoryMock).toHaveBeenCalledWith(
      expect.anything(),
      "learner-1",
      expect.objectContaining({ evidenceId: "ev1", type: "EVIDENCE_STANDING_CHANGED" }),
      expect.anything()
    );
  });

  it("limit above MAX_LIMIT -> 400, domain function never called", async () => {
    mockAuthed("INSTRUCTOR");
    requireRoleMock.mockImplementation(() => {});

    const res = await GET(req("?limit=500"), params);

    expect(res.status).toBe(400);
    expect(getHistoryMock).not.toHaveBeenCalled();
  });

  it("invalid cursor from domain layer -> 400", async () => {
    mockAuthed("INSTRUCTOR");
    requireRoleMock.mockImplementation(() => {});
    getHistoryMock.mockRejectedValue(new HistoryCursorError());

    const res = await GET(req("?cursor=garbage"), params);

    expect(res.status).toBe(400);
  });
});
