import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level test for GET /api/capability/history, following the same
 * vi.mock(@/lib/auth/context) + vi.mock(domain module) pattern established
 * by org/capability/route.test.ts — status-mapping/validation/response
 * logic only. Privacy/authorization leak proofs live in history.test.ts
 * against the real domain layer and database, which a mocked domain module
 * here cannot demonstrate.
 */
vi.mock("@/lib/auth/context", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/context")>("@/lib/auth/context");
  return { ...actual, requireAuthContext: vi.fn(), requireTenant: vi.fn() };
});

vi.mock("@/lib/domain/capability/history", async () => {
  const actual = await vi.importActual<typeof import("@/lib/domain/capability/history")>(
    "@/lib/domain/capability/history"
  );
  return {
    HistoryCursorError: actual.HistoryCursorError,
    MAX_LIMIT: actual.MAX_LIMIT,
    getLearnerHistory: vi.fn(),
  };
});

const { AuthContextError, requireAuthContext, requireTenant } = await import("@/lib/auth/context");
const { getLearnerHistory, HistoryCursorError } = await import("@/lib/domain/capability/history");
const { GET } = await import("./route");

const requireAuthContextMock = vi.mocked(requireAuthContext);
const requireTenantMock = vi.mocked(requireTenant);
const getLearnerHistoryMock = vi.mocked(getLearnerHistory);
const req = (qs = "") => new Request(`http://localhost/api/capability/history${qs}`);

function mockAuthed() {
  requireAuthContextMock.mockResolvedValue({
    userId: "u1",
    clerkId: "c1",
    tenantId: "t1",
    role: "STUDENT",
  });
  requireTenantMock.mockImplementation(() => {});
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/capability/history", () => {
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
      role: "STUDENT",
    });
    requireTenantMock.mockImplementation(() => {
      throw new AuthContextError(400, "No organisation found");
    });

    const res = await GET(req());

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "No organisation found" });
  });

  it("authenticated -> 200, tenant/user taken only from ctx", async () => {
    mockAuthed();
    getLearnerHistoryMock.mockResolvedValue({ items: [], nextCursor: null });

    // userId/tenantId in the query string must never override the ctx.
    const res = await GET(req("?userId=someone-else&tenantId=another-tenant"));

    expect(res.status).toBe(200);
    expect(getLearnerHistoryMock).toHaveBeenCalledWith(
      { userId: "u1", clerkId: "c1", tenantId: "t1", role: "STUDENT" },
      { skillId: undefined, type: undefined, from: undefined, to: undefined },
      { cursor: undefined, limit: undefined }
    );
  });

  it("passes skillId/type/cursor/limit filters through", async () => {
    mockAuthed();
    getLearnerHistoryMock.mockResolvedValue({ items: [], nextCursor: null });

    await GET(req("?skillId=s1&type=PROFICIENCY_CHANGED&cursor=abc&limit=10"));

    expect(getLearnerHistoryMock).toHaveBeenCalledWith(
      expect.anything(),
      { skillId: "s1", type: "PROFICIENCY_CHANGED", from: undefined, to: undefined },
      { cursor: "abc", limit: 10 }
    );
  });

  it("invalid type -> 400", async () => {
    mockAuthed();
    const res = await GET(req("?type=NOT_A_TYPE"));
    expect(res.status).toBe(400);
    expect(getLearnerHistoryMock).not.toHaveBeenCalled();
  });

  it("limit above MAX_LIMIT -> 400", async () => {
    mockAuthed();
    const res = await GET(req("?limit=101"));
    expect(res.status).toBe(400);
    expect(getLearnerHistoryMock).not.toHaveBeenCalled();
  });

  it("limit below 1 -> 400", async () => {
    mockAuthed();
    const res = await GET(req("?limit=0"));
    expect(res.status).toBe(400);
  });

  it("bad from date (local-time string, no Z/offset) -> 400", async () => {
    mockAuthed();
    const res = await GET(req("?from=2026-03-01T00:00"));
    expect(res.status).toBe(400);
    expect(getLearnerHistoryMock).not.toHaveBeenCalled();
  });

  it("date-only from -> parsed as UTC midnight", async () => {
    mockAuthed();
    getLearnerHistoryMock.mockResolvedValue({ items: [], nextCursor: null });

    await GET(req("?from=2026-03-01"));

    expect(getLearnerHistoryMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ from: new Date("2026-03-01T00:00:00.000Z") }),
      expect.anything()
    );
  });

  it("full ISO with Z -> accepted", async () => {
    mockAuthed();
    getLearnerHistoryMock.mockResolvedValue({ items: [], nextCursor: null });

    await GET(req("?to=2026-03-01T12:30:00.000Z"));

    expect(getLearnerHistoryMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ to: new Date("2026-03-01T12:30:00.000Z") }),
      expect.anything()
    );
  });

  it("invalid cursor from domain layer -> 400", async () => {
    mockAuthed();
    getLearnerHistoryMock.mockRejectedValue(new HistoryCursorError());

    const res = await GET(req("?cursor=garbage"));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid cursor" });
  });

  it("unexpected domain error -> 500, no internal details leaked", async () => {
    mockAuthed();
    getLearnerHistoryMock.mockRejectedValue(new Error("connection refused at 10.0.0.5:5432"));

    const res = await GET(req());

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).not.toContain("10.0.0.5");
  });
});
