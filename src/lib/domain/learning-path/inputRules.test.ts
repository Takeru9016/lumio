import { describe, expect, it } from "vitest";
import type { AuthContext } from "@/lib/auth/context";
import {
  LEARNING_PATH_DESCRIPTION_MAX_LENGTH,
  LEARNING_PATH_MAX_COURSES,
  LEARNING_PATH_TITLE_MAX_LENGTH,
} from "@/lib/domain/learning-path/constants";
import {
  buildNewPath,
  parseCreatePathInput,
  parseUpdatePathInput,
  validateDescription,
  validateTitle,
} from "@/lib/domain/learning-path/inputRules";
import { LearningPathError } from "@/lib/domain/learning-path/types";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof LearningPathError) return err.code;
    throw err;
  }
  return "NO_ERROR";
}

const ctx = (over: Partial<AuthContext> = {}): AuthContext => ({
  userId: "user-1",
  clerkId: "clerk-1",
  tenantId: "tenant-a",
  role: "ORG_ADMIN",
  ...over,
});

describe("V1 constants", () => {
  it("are the documented product limits", () => {
    expect(LEARNING_PATH_MAX_COURSES).toBe(20);
    expect(LEARNING_PATH_TITLE_MAX_LENGTH).toBe(100);
    expect(LEARNING_PATH_DESCRIPTION_MAX_LENGTH).toBe(1000);
  });
});

describe("validateTitle", () => {
  it("rejects an empty title and a whitespace-only one", () => {
    expect(codeOf(() => validateTitle(""))).toBe("INVALID_INPUT");
    expect(codeOf(() => validateTitle("   \t "))).toBe("INVALID_INPUT");
  });

  it("accepts 1 character and exactly 100, and rejects 101", () => {
    expect(validateTitle("a")).toBe("a");
    expect(validateTitle("a".repeat(100))).toHaveLength(100);
    expect(codeOf(() => validateTitle("a".repeat(101)))).toBe("INVALID_INPUT");
  });

  it("trims before measuring", () => {
    expect(validateTitle(`  ${"a".repeat(100)}  `)).toBe("a".repeat(100));
    expect(validateTitle("  Onboarding  ")).toBe("Onboarding");
  });

  it.each([undefined, null, 5, {}, [], true])("rejects a non-string (%s)", (value) => {
    expect(codeOf(() => validateTitle(value))).toBe("INVALID_INPUT");
  });

  it.each(["a\u0000b", "a\nb", "a\tb", "a\u007fb", "\ud800"])(
    "rejects characters the database or a single-line title cannot hold (%j)",
    (value) => {
      expect(codeOf(() => validateTitle(value))).toBe("INVALID_INPUT");
    }
  );
});

describe("validateDescription", () => {
  it("treats missing, null, empty and blank as no description", () => {
    expect(validateDescription(undefined)).toBeNull();
    expect(validateDescription(null)).toBeNull();
    expect(validateDescription("")).toBeNull();
    expect(validateDescription("  \n ")).toBeNull();
  });

  it("accepts exactly 1000 characters and rejects 1001", () => {
    expect(validateDescription("d".repeat(1000))).toHaveLength(1000);
    expect(codeOf(() => validateDescription("d".repeat(1001)))).toBe("INVALID_INPUT");
  });

  it("allows line breaks and tabs, and trims", () => {
    expect(validateDescription("  line one\nline two\tend  ")).toBe("line one\nline two\tend");
  });

  it.each([5, {}, [], true])("rejects a non-string (%s)", (value) => {
    expect(codeOf(() => validateDescription(value))).toBe("INVALID_INPUT");
  });

  it.each(["a\u0000b", "a\u0001b", "\udc00"])("rejects unstorable characters (%j)", (value) => {
    expect(codeOf(() => validateDescription(value))).toBe("INVALID_INPUT");
  });
});

describe("parseCreatePathInput", () => {
  it("takes a title and an optional description", () => {
    expect(parseCreatePathInput({ title: " Path ", description: " Why " })).toEqual({
      title: "Path",
      description: "Why",
    });
    expect(parseCreatePathInput({ title: "Path" })).toEqual({ title: "Path", description: null });
  });

  it.each([
    "tenantId",
    "createdById",
    "status",
    "position",
    "id",
    "publishedAt",
    "courses",
    "createdAt",
    "__proto__",
  ])("refuses a body that names %s: the server decides that, not the caller", (key) => {
    const body = JSON.parse(`{"title":"Path","${key}":"forged"}`);

    expect(codeOf(() => parseCreatePathInput(body))).toBe("INVALID_INPUT");
  });

  it.each([null, undefined, "x", 5, [], [{ title: "x" }]])(
    "rejects a non-object body (%s)",
    (v) => {
      expect(codeOf(() => parseCreatePathInput(v))).toBe("INVALID_INPUT");
    }
  );

  it("requires a title", () => {
    expect(codeOf(() => parseCreatePathInput({}))).toBe("INVALID_INPUT");
    expect(codeOf(() => parseCreatePathInput({ description: "only" }))).toBe("INVALID_INPUT");
  });
});

describe("parseUpdatePathInput", () => {
  it("returns only the fields that were supplied", () => {
    expect(parseUpdatePathInput({ title: "New" })).toEqual({ title: "New" });
    expect(parseUpdatePathInput({ description: "Words" })).toEqual({ description: "Words" });
  });

  it("null and blank clear the description, undefined leaves it alone", () => {
    expect(parseUpdatePathInput({ description: null })).toEqual({ description: null });
    expect(parseUpdatePathInput({ description: "  " })).toEqual({ description: null });
    expect(parseUpdatePathInput({ title: "T", description: undefined })).toEqual({ title: "T" });
  });

  it("refuses an empty update, an empty title and any forged field", () => {
    expect(codeOf(() => parseUpdatePathInput({}))).toBe("INVALID_INPUT");
    expect(codeOf(() => parseUpdatePathInput({ title: "" }))).toBe("INVALID_INPUT");
    for (const key of ["tenantId", "createdById", "status", "publishedAt", "position"]) {
      expect(codeOf(() => parseUpdatePathInput({ title: "T", [key]: "x" }))).toBe("INVALID_INPUT");
    }
  });
});

describe("buildNewPath — the server decides tenant, creator and status", () => {
  it("takes tenant and creator from the authenticated context and starts as DRAFT", () => {
    expect(buildNewPath(ctx(), { title: "Path" })).toEqual({
      tenantId: "tenant-a",
      createdById: "user-1",
      title: "Path",
      description: null,
      status: "DRAFT",
    });
  });

  it("a forged tenantId, createdById or status in the input is refused, never used", () => {
    for (const forged of [
      { tenantId: "tenant-evil" },
      { createdById: "user-evil" },
      { status: "PUBLISHED" },
    ]) {
      expect(codeOf(() => buildNewPath(ctx(), { title: "Path", ...forged }))).toBe("INVALID_INPUT");
    }
  });

  it.each(["STUDENT", "INSTRUCTOR", "SUPER_ADMIN"] as const)("%s is forbidden", (role) => {
    expect(codeOf(() => buildNewPath(ctx({ role }), { title: "Path" }))).toBe("FORBIDDEN");
  });

  it("an ORG_ADMIN with no tenant is forbidden, so a path is never tenantless", () => {
    expect(codeOf(() => buildNewPath(ctx({ tenantId: null }), { title: "Path" }))).toBe(
      "FORBIDDEN"
    );
  });

  it("authorization is decided before the input is looked at", () => {
    expect(codeOf(() => buildNewPath(ctx({ role: "STUDENT" }), { forged: true }))).toBe(
      "FORBIDDEN"
    );
    expect(codeOf(() => buildNewPath(ctx({ role: "STUDENT" }), null))).toBe("FORBIDDEN");
  });
});
