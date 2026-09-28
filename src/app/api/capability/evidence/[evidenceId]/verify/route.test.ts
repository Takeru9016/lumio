import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level test for POST /api/capability/evidence/[evidenceId]/verify.
 * Follows this repo's one established route-mocking pattern
 * (recommendations/route.test.ts) — mocks `@/lib/auth/context` and the
 * capability domain functions, not Clerk itself, so the route's OWN logic
 * (action dispatch, reason validation, status mapping, and — critically —
 * that nothing from the request body besides `action`/`reason` ever reaches
 * the domain layer) runs for real.
 */
vi.mock("@/lib/auth/context", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/context")>("@/lib/auth/context");
  return { ...actual, requireAuthContext: vi.fn(), requireTenant: vi.fn() };
});

vi.mock("@/lib/domain/capability/verification", async () => {
  const actual = await vi.importActual<typeof import("@/lib/domain/capability/verification")>(
    "@/lib/domain/capability/verification"
  );
  return {
    ...actual,
    verifyEvidence: vi.fn(),
    rejectEvidence: vi.fn(),
    unverifyEvidence: vi.fn(),
    reopenEvidence: vi.fn(),
    revokeEvidence: vi.fn(),
    reinstateEvidence: vi.fn(),
  };
});

const { AuthContextError, requireAuthContext, requireTenant } = await import("@/lib/auth/context");
const {
  CapabilityVerificationError,
  verifyEvidence,
  rejectEvidence,
  unverifyEvidence,
  reopenEvidence,
  revokeEvidence,
  reinstateEvidence,
} = await import("@/lib/domain/capability/verification");
const { POST } = await import("./route");

const requireAuthContextMock = vi.mocked(requireAuthContext);
const requireTenantMock = vi.mocked(requireTenant);
const verifyEvidenceMock = vi.mocked(verifyEvidence);
const rejectEvidenceMock = vi.mocked(rejectEvidence);
const unverifyEvidenceMock = vi.mocked(unverifyEvidence);
const reopenEvidenceMock = vi.mocked(reopenEvidence);
const revokeEvidenceMock = vi.mocked(revokeEvidence);
const reinstateEvidenceMock = vi.mocked(reinstateEvidence);

const ctx = {
  userId: "user-1",
  clerkId: "clerk-1",
  tenantId: "tenant-1",
  role: "INSTRUCTOR" as const,
};
const fakeUserSkill = { id: "us-1", proficiency: "INTERMEDIATE" } as Awaited<
  ReturnType<typeof verifyEvidence>
>;

function req(body: unknown) {
  return new Request("http://localhost/api/capability/evidence/ev-1/verify", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
function params() {
  return Promise.resolve({ evidenceId: "ev-1" });
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("POST .../verify — auth", () => {
  it("unauthenticated -> 401", async () => {
    requireAuthContextMock.mockRejectedValue(new AuthContextError(401, "Unauthorized"));
    const res = await POST(req({ action: "verify" }), { params: params() });
    expect(res.status).toBe(401);
  });

  it("no tenant -> whatever requireTenant throws", async () => {
    requireAuthContextMock.mockResolvedValue(ctx);
    requireTenantMock.mockImplementation(() => {
      throw new AuthContextError(400, "No tenant");
    });
    const res = await POST(req({ action: "verify" }), { params: params() });
    expect(res.status).toBe(400);
  });
});

describe("POST .../verify — action dispatch, every action reaches its own domain function with ONLY (ctx, evidenceId[, reason])", () => {
  beforeEachAuthed();

  it("verify", async () => {
    verifyEvidenceMock.mockResolvedValue(fakeUserSkill);
    const res = await POST(req({ action: "verify" }), { params: params() });
    expect(res.status).toBe(200);
    expect(verifyEvidenceMock).toHaveBeenCalledWith(ctx, "ev-1");
  });

  it("reject", async () => {
    rejectEvidenceMock.mockResolvedValue(fakeUserSkill);
    const res = await POST(req({ action: "reject" }), { params: params() });
    expect(res.status).toBe(200);
    expect(rejectEvidenceMock).toHaveBeenCalledWith(ctx, "ev-1");
  });

  it("unverify", async () => {
    unverifyEvidenceMock.mockResolvedValue(fakeUserSkill);
    const res = await POST(req({ action: "unverify" }), { params: params() });
    expect(res.status).toBe(200);
    expect(unverifyEvidenceMock).toHaveBeenCalledWith(ctx, "ev-1");
  });

  it("reopen", async () => {
    reopenEvidenceMock.mockResolvedValue(fakeUserSkill);
    const res = await POST(req({ action: "reopen" }), { params: params() });
    expect(res.status).toBe(200);
    expect(reopenEvidenceMock).toHaveBeenCalledWith(ctx, "ev-1");
  });

  it("revoke, with reason", async () => {
    revokeEvidenceMock.mockResolvedValue(fakeUserSkill);
    const res = await POST(req({ action: "revoke", reason: "data-entry error" }), {
      params: params(),
    });
    expect(res.status).toBe(200);
    expect(revokeEvidenceMock).toHaveBeenCalledWith(ctx, "ev-1", "data-entry error");
  });

  it("reinstate, with reason", async () => {
    reinstateEvidenceMock.mockResolvedValue(fakeUserSkill);
    const res = await POST(req({ action: "reinstate", reason: "correction reverted" }), {
      params: params(),
    });
    expect(res.status).toBe(200);
    expect(reinstateEvidenceMock).toHaveBeenCalledWith(ctx, "ev-1", "correction reverted");
  });
});

describe("POST .../verify — revoke/reinstate require a non-empty reason; other actions never do", () => {
  beforeEachAuthed();

  it("revoke without a reason -> 400, domain function never called", async () => {
    const res = await POST(req({ action: "revoke" }), { params: params() });
    expect(res.status).toBe(400);
    expect(revokeEvidenceMock).not.toHaveBeenCalled();
  });

  it("revoke with a blank/whitespace-only reason -> 400", async () => {
    const res = await POST(req({ action: "revoke", reason: "   " }), { params: params() });
    expect(res.status).toBe(400);
    expect(revokeEvidenceMock).not.toHaveBeenCalled();
  });

  it("reinstate without a reason -> 400", async () => {
    const res = await POST(req({ action: "reinstate" }), { params: params() });
    expect(res.status).toBe(400);
    expect(reinstateEvidenceMock).not.toHaveBeenCalled();
  });

  it("verify with a stray reason field is fine — reason is simply ignored for that branch", async () => {
    verifyEvidenceMock.mockResolvedValue(fakeUserSkill);
    const res = await POST(req({ action: "verify", reason: "unused" }), { params: params() });
    expect(res.status).toBe(200);
    expect(verifyEvidenceMock).toHaveBeenCalledWith(ctx, "ev-1");
  });
});

describe("POST .../verify — a forged actorId/verifiedById/tenantId in the body is silently ignored", () => {
  beforeEachAuthed();

  it("extra client-supplied identity fields never reach the domain function", async () => {
    verifyEvidenceMock.mockResolvedValue(fakeUserSkill);
    const res = await POST(
      req({
        action: "verify",
        actorId: "someone-else",
        verifiedById: "someone-else",
        tenantId: "another-tenant",
        userId: "another-user",
      }),
      { params: params() }
    );
    expect(res.status).toBe(200);
    // Only (ctx, evidenceId) — the authenticated ctx, never anything from the body.
    expect(verifyEvidenceMock).toHaveBeenCalledWith(ctx, "ev-1");
    expect(verifyEvidenceMock).toHaveBeenCalledTimes(1);
  });
});

describe("POST .../verify — error mapping", () => {
  beforeEachAuthed();

  it("invalid JSON -> 400", async () => {
    const res = await POST(
      new Request("http://localhost/api/capability/evidence/ev-1/verify", {
        method: "POST",
        body: "not json",
      }),
      { params: params() }
    );
    expect(res.status).toBe(400);
  });

  it("unknown action -> 400", async () => {
    const res = await POST(req({ action: "delete-everything" }), { params: params() });
    expect(res.status).toBe(400);
  });

  it("CapabilityVerificationError propagates its own status (404 for missing/cross-tenant, per D23)", async () => {
    verifyEvidenceMock.mockRejectedValue(
      new CapabilityVerificationError(404, "Evidence not found")
    );
    const res = await POST(req({ action: "verify" }), { params: params() });
    expect(res.status).toBe(404);
  });

  it("CapabilityVerificationError 409 (illegal transition) propagates as 409", async () => {
    verifyEvidenceMock.mockRejectedValue(new CapabilityVerificationError(409, "Not active"));
    const res = await POST(req({ action: "verify" }), { params: params() });
    expect(res.status).toBe(409);
  });

  it("an unexpected error -> 500, generic message", async () => {
    verifyEvidenceMock.mockRejectedValue(new Error("boom"));
    const res = await POST(req({ action: "verify" }), { params: params() });
    expect(res.status).toBe(500);
  });
});

function beforeEachAuthed() {
  beforeEach(() => {
    requireAuthContextMock.mockResolvedValue(ctx);
    requireTenantMock.mockReturnValue(undefined);
  });
}
