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
    getOrgLearnerHistory: vi.fn(),
  };
});

const { AuthContextError, requireAuthContext, requireTenant, requireRole } = await import(
  "@/lib/auth/context"
);
const { getOrgLearnerHistory, HistoryCursorError } = await import(
  "@/lib/domain/capability/history"
);
const { GET } = await import("./route");

const requireAuthContextMock = vi.mocked(requireAuthContext);
const requireTenantMock = vi.mocked(requireTenant);
const requireRoleMock = vi.mocked(requireRole);
const getHistoryMock = vi.mocked(getOrgLearnerHistory);

const req = (qs = "") => new Request(`http://localhost/api/org/capability/learner-1/history${qs}`);
const params = { params: Promise.resolve({ learnerId: "learner-1" }) };

function mockAuthed(role: "STUDENT" | "INSTRUCTOR" | "ORG_ADMIN" | "SUPER_ADMIN" = "ORG_ADMIN") {
  requireAuthContextMock.mockResolvedValue({ userId: "u1", clerkId: "c1", tenantId: "t1", role });
  requireTenantMock.mockImplementation(() => {});
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/org/capability/[learnerId]/history", () => {
  it("unauthenticated -> 401", async () => {
    requireAuthContextMock.mockRejectedValue(new AuthContextError(401, "Unauthorized"));
    const res = await GET(req(), params);
    expect(res.status).toBe(401);
  });

  it("INSTRUCTOR -> 403 (this route is ORG_ADMIN-only)", async () => {
    mockAuthed("INSTRUCTOR");
    requireRoleMock.mockImplementation(() => {
      throw new AuthContextError(403, "Forbidden");
    });
    const res = await GET(req(), params);
    expect(res.status).toBe(403);
  });

  it("SUPER_ADMIN -> 403 — no implicit broadening onto this route (discovery §9)", async () => {
    mockAuthed("SUPER_ADMIN");
    requireRoleMock.mockImplementation(() => {
      throw new AuthContextError(403, "Forbidden");
    });
    const res = await GET(req(), params);
    expect(res.status).toBe(403);
  });

  it("ORG_ADMIN -> 200, tenant taken only from ctx", async () => {
    mockAuthed("ORG_ADMIN");
    requireRoleMock.mockImplementation(() => {});
    getHistoryMock.mockResolvedValue({ items: [], nextCursor: null });

    const res = await GET(req("?tenantId=someone-elses-tenant"), params);

    expect(res.status).toBe(200);
    expect(getHistoryMock).toHaveBeenCalledWith(
      { userId: "u1", clerkId: "c1", tenantId: "t1", role: "ORG_ADMIN" },
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

  it("domain function returns null (foreign tenant / soft-deleted / not found) -> 404", async () => {
    mockAuthed("ORG_ADMIN");
    requireRoleMock.mockImplementation(() => {});
    getHistoryMock.mockResolvedValue(null);

    const res = await GET(req(), params);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Learner not found" });
  });

  it("limit above MAX_LIMIT -> 400", async () => {
    mockAuthed("ORG_ADMIN");
    requireRoleMock.mockImplementation(() => {});
    const res = await GET(req("?limit=101"), params);
    expect(res.status).toBe(400);
    expect(getHistoryMock).not.toHaveBeenCalled();
  });

  it("invalid cursor from domain layer -> 400", async () => {
    mockAuthed("ORG_ADMIN");
    requireRoleMock.mockImplementation(() => {});
    getHistoryMock.mockRejectedValue(new HistoryCursorError());
    const res = await GET(req("?cursor=garbage"), params);
    expect(res.status).toBe(400);
  });
});
