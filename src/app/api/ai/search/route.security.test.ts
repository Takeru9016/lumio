import { afterAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  addTeamMember,
  createIndexedDocument,
  createTeam,
  fakeEmbedding,
  grantAccess,
} from "@/lib/domain/knowledge/__test__/fixtures";

/**
 * End-to-end security test for POST /api/ai/search against the REAL
 * database (real buildAIContext -> real searchKnowledge), not a mocked
 * context — per the Phase 10 contract's instruction to prove the Search
 * route itself respects searchKnowledge()'s existing tenant/permission
 * predicate, reusing the same fixtures retrieval.security.test.ts uses
 * rather than re-implementing retrieval. Only the true external boundaries
 * (Clerk auth, rate limiter, the LLM call) are mocked.
 */
const QUERY_VECTOR = fakeEmbedding(999);
vi.mock("@/lib/ai/embeddings", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/embeddings")>("@/lib/ai/embeddings");
  return { ...actual, generateEmbedding: vi.fn().mockResolvedValue(QUERY_VECTOR) };
});

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));
vi.mock("@/lib/ratelimit", () => ({
  searchRatelimit: { limit: vi.fn().mockResolvedValue({ success: true }) },
}));
vi.mock("ai", () => ({ generateText: vi.fn() }));

const { auth } = await import("@clerk/nextjs/server");
const { generateText } = await import("ai");
const { POST } = await import("./route");

const authMock = vi.mocked(auth);
const generateTextMock = vi.mocked(generateText);

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

async function createStudent(tenantId: string) {
  return db.user.create({
    data: {
      clerkId: unique("clerk"),
      email: `${unique("student")}@example.test`,
      tenantId,
      role: "STUDENT",
      plan: "STARTER",
    },
  });
}

async function createTenant() {
  return db.tenant.create({ data: { name: unique("tenant"), slug: unique("tenant-slug") } });
}

function req(query: string) {
  return new Request("http://localhost/api/ai/search", {
    method: "POST",
    body: JSON.stringify({ query }),
  });
}

afterAll(async () => {
  await db.$disconnect();
});

describe("POST /api/ai/search — end-to-end tenant/permission isolation", () => {
  it("a student never receives another tenant's TENANT-visibility Knowledge as a citation", async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();
    const studentA = await createStudent(tenantA.id);

    await createIndexedDocument({
      tenantId: tenantA.id,
      title: "Tenant A doc",
      content: "tenant a content",
      embedding: QUERY_VECTOR,
    });
    await createIndexedDocument({
      tenantId: tenantB.id,
      title: "Tenant B SECRET doc",
      content: "tenant b secret content",
      embedding: QUERY_VECTOR,
    });

    authMock.mockResolvedValue({ userId: studentA.clerkId } as never);
    generateTextMock.mockResolvedValue({ text: "Answer.", usage: {} } as never);

    const res = await POST(req("anything (mocked)"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(
      body.citations.some((c: { documentTitle: string }) => c.documentTitle.includes("SECRET"))
    ).toBe(false);
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("a RESTRICTED document without a matching access row is never cited", async () => {
    const tenant = await createTenant();
    const student = await createStudent(tenant.id);

    const { document } = await createIndexedDocument({
      tenantId: tenant.id,
      title: "Restricted doc",
      content: "restricted content",
      embedding: QUERY_VECTOR,
      visibility: "RESTRICTED",
    });

    authMock.mockResolvedValue({ userId: student.clerkId } as never);
    generateTextMock.mockResolvedValue({ text: "Answer.", usage: {} } as never);

    const res = await POST(req("q"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.citations.some((c: { documentId: string }) => c.documentId === document.id)).toBe(
      false
    );
  });

  it("a RESTRICTED document with a matching USER access row is cited for that user", async () => {
    const tenant = await createTenant();
    const student = await createStudent(tenant.id);

    const { document } = await createIndexedDocument({
      tenantId: tenant.id,
      title: "User-restricted doc",
      content: "only this student should see this",
      embedding: QUERY_VECTOR,
      visibility: "RESTRICTED",
    });
    await grantAccess({
      tenantId: tenant.id,
      documentId: document.id,
      scope: "USER",
      userId: student.id,
    });

    authMock.mockResolvedValue({ userId: student.clerkId } as never);
    generateTextMock.mockResolvedValue({ text: "Answer.", usage: {} } as never);

    const res = await POST(req("q"));
    const body = await res.json();

    expect(body.citations.some((c: { documentId: string }) => c.documentId === document.id)).toBe(
      true
    );
  });

  it("a TEAM-restricted document is cited only for an authorized team member, not a non-member", async () => {
    const tenant = await createTenant();
    const member = await createStudent(tenant.id);
    const nonMember = await createStudent(tenant.id);
    const team = await createTeam(tenant.id);
    await addTeamMember(team.id, member.id);

    const { document } = await createIndexedDocument({
      tenantId: tenant.id,
      title: "Team-restricted doc",
      content: "only team members should see this",
      embedding: QUERY_VECTOR,
      visibility: "RESTRICTED",
    });
    await grantAccess({
      tenantId: tenant.id,
      documentId: document.id,
      scope: "TEAM",
      teamId: team.id,
    });

    generateTextMock.mockResolvedValue({ text: "Answer.", usage: {} } as never);

    authMock.mockResolvedValue({ userId: member.clerkId } as never);
    const memberRes = await POST(req("q"));
    const memberBody = await memberRes.json();
    expect(
      memberBody.citations.some((c: { documentId: string }) => c.documentId === document.id)
    ).toBe(true);

    authMock.mockResolvedValue({ userId: nonMember.clerkId } as never);
    const nonMemberRes = await POST(req("q"));
    const nonMemberBody = await nonMemberRes.json();
    expect(
      nonMemberBody.citations.some((c: { documentId: string }) => c.documentId === document.id)
    ).toBe(false);
  });
});
