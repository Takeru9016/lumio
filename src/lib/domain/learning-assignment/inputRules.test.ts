import { describe, expect, it } from "vitest";
import {
  isValidDueDate,
  isValidId,
  isValidNote,
  MAX_NOTE_LENGTH,
} from "@/lib/domain/learning-assignment/inputRules";

describe("isValidId", () => {
  it("accepts cuid-style and hyphenated ids", () => {
    expect(isValidId("cmf3k2x0a0000abcd1234efgh")).toBe(true);
    expect(isValidId("does-not-exist")).toBe(true);
    expect(isValidId("a_b-C9")).toBe(true);
  });

  it("rejects non-strings, empty and oversized ids", () => {
    for (const value of [undefined, null, 123, {}, [], "", "x".repeat(129)]) {
      expect(isValidId(value)).toBe(false);
    }
    expect(isValidId("x".repeat(128))).toBe(true);
  });

  it("rejects characters that could corrupt a query or the database driver", () => {
    for (const value of ["a b", "a'b", "a;b", "a/b", "a\u0000b", "a\nb", "é", "a%00b"]) {
      expect(isValidId(value)).toBe(false);
    }
  });
});

describe("isValidDueDate", () => {
  it("accepts an ordinary date, past or future", () => {
    expect(isValidDueDate(new Date("2027-01-15T23:59:59.999Z"))).toBe(true);
    expect(isValidDueDate(new Date("2020-01-01T00:00:00.000Z"))).toBe(true);
  });

  it("rejects non-dates and invalid dates", () => {
    for (const value of [undefined, null, "2027-01-01", 1_800_000_000_000, new Date("nope")]) {
      expect(isValidDueDate(value)).toBe(false);
    }
  });

  it("rejects dates the database driver cannot store or that are absurd", () => {
    expect(isValidDueDate(new Date(-8.64e15))).toBe(false);
    expect(isValidDueDate(new Date(8.64e15))).toBe(false);
    expect(isValidDueDate(new Date("1969-12-31T23:59:59.999Z"))).toBe(false);
    expect(isValidDueDate(new Date("2101-01-01T00:00:00.000Z"))).toBe(false);
  });

  it("accepts the window edges", () => {
    expect(isValidDueDate(new Date("1970-01-01T00:00:00.000Z"))).toBe(true);
    expect(isValidDueDate(new Date("2100-12-31T23:59:59.999Z"))).toBe(true);
  });
});

describe("isValidNote", () => {
  it("accepts ordinary text, including newlines and tabs", () => {
    expect(isValidNote("Please finish this before the audit.")).toBe(true);
    expect(isValidNote("line one\nline two\r\n\tindented")).toBe(true);
    expect(isValidNote("naïve — 日本語 ✓")).toBe(true);
  });

  it("enforces the length bound inclusively", () => {
    expect(isValidNote("x".repeat(MAX_NOTE_LENGTH))).toBe(true);
    expect(isValidNote("x".repeat(MAX_NOTE_LENGTH + 1))).toBe(false);
  });

  it("rejects NUL and other control characters", () => {
    for (const value of ["a\u0000b", "a\u0001b", "a\u001Fb", "a\u007Fb", "a\u000Bb", "a\u000Cb"]) {
      expect(isValidNote(value)).toBe(false);
    }
  });

  it("rejects lone surrogates that a JSON column cannot store", () => {
    expect(isValidNote("a\uD800b")).toBe(false);
    expect(isValidNote("a\uDC00b")).toBe(false);
    expect(isValidNote("emoji 😀 pair is fine")).toBe(true);
  });
});
