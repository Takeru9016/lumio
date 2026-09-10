import { describe, expect, it } from "vitest";
import {
  canReadKnowledgeDocument,
  type KnowledgeAccessContext,
} from "@/lib/domain/knowledge/access";

const ctx: KnowledgeAccessContext = {
  userId: "user-a",
  clerkId: "clerk-a",
  tenantId: "tenant-a",
  role: "STUDENT",
};

describe("canReadKnowledgeDocument (pure policy predicate)", () => {
  it("denies when the document belongs to a different tenant, regardless of visibility", () => {
    const doc = { tenantId: "tenant-b", status: "READY", visibility: "TENANT" as const };
    expect(canReadKnowledgeDocument(ctx, doc, [], [])).toBe(false);
  });

  it("denies a same-tenant document that is not READY", () => {
    const doc = { tenantId: "tenant-a", status: "PENDING", visibility: "TENANT" as const };
    expect(canReadKnowledgeDocument(ctx, doc, [], [])).toBe(false);
  });

  it("allows a same-tenant READY TENANT-visibility document with zero access rows", () => {
    const doc = { tenantId: "tenant-a", status: "READY", visibility: "TENANT" as const };
    expect(canReadKnowledgeDocument(ctx, doc, [], [])).toBe(true);
  });

  it("denies a RESTRICTED document with zero access rows (fail closed)", () => {
    const doc = { tenantId: "tenant-a", status: "READY", visibility: "RESTRICTED" as const };
    expect(canReadKnowledgeDocument(ctx, doc, [], [])).toBe(false);
  });

  it("allows a RESTRICTED document via a matching USER-scope row", () => {
    const doc = { tenantId: "tenant-a", status: "READY", visibility: "RESTRICTED" as const };
    const rows = [{ scope: "USER" as const, teamId: null, userId: "user-a" }];
    expect(canReadKnowledgeDocument(ctx, doc, rows, [])).toBe(true);
  });

  it("denies a RESTRICTED document's USER-scope row for a different user", () => {
    const doc = { tenantId: "tenant-a", status: "READY", visibility: "RESTRICTED" as const };
    const rows = [{ scope: "USER" as const, teamId: null, userId: "user-b" }];
    expect(canReadKnowledgeDocument(ctx, doc, rows, [])).toBe(false);
  });

  it("allows a RESTRICTED document via a matching TEAM-scope row when the user is on that team", () => {
    const doc = { tenantId: "tenant-a", status: "READY", visibility: "RESTRICTED" as const };
    const rows = [{ scope: "TEAM" as const, teamId: "team-1", userId: null }];
    expect(canReadKnowledgeDocument(ctx, doc, rows, ["team-1"])).toBe(true);
  });

  it("denies a RESTRICTED document's TEAM-scope row when the user is not on that team", () => {
    const doc = { tenantId: "tenant-a", status: "READY", visibility: "RESTRICTED" as const };
    const rows = [{ scope: "TEAM" as const, teamId: "team-1", userId: null }];
    expect(canReadKnowledgeDocument(ctx, doc, rows, ["team-2"])).toBe(false);
  });

  it("allows a RESTRICTED document via a TENANT-scope access row (opt back in)", () => {
    const doc = { tenantId: "tenant-a", status: "READY", visibility: "RESTRICTED" as const };
    const rows = [{ scope: "TENANT" as const, teamId: null, userId: null }];
    expect(canReadKnowledgeDocument(ctx, doc, rows, [])).toBe(true);
  });
});
