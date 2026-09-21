import { describe, expect, it } from "vitest";
import {
  LEARNING_PATH_PAGE_MAX,
  LEARNING_PATH_PAGE_SIZE,
} from "@/lib/domain/learning-path/constants";
import { decodeCursor, encodeCursor, parseListQuery } from "@/lib/domain/learning-path/listing";
import { LearningPathError } from "@/lib/domain/learning-path/types";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");

function codeOf(call: () => unknown): string | null {
  try {
    call();
    return null;
  } catch (err) {
    return err instanceof LearningPathError ? err.code : `UNEXPECTED:${String(err)}`;
  }
}

describe("cursors", () => {
  it("round-trip the instant to the millisecond and the id", () => {
    const at = new Date("2026-05-06T07:08:09.123Z");

    expect(decodeCursor(encodeCursor({ createdAt: at, id: "abc_-123" }))).toEqual({
      createdAt: at,
      id: "abc_-123",
    });
  });

  it.each([
    ["not base64 JSON", "@@@"],
    ["JSON that is not an object", b64([1])],
    ["a missing id", b64({ createdAt: "2026-01-01T00:00:00.000Z" })],
    ["a missing date", b64({ id: "abc" })],
    ["a date that is not an ISO instant", b64({ createdAt: "2026-01-01", id: "abc" })],
    ["an impossible date", b64({ createdAt: "2026-02-31T00:00:00.000Z", id: "abc" })],
    ["a numeric date", b64({ createdAt: 5, id: "abc" })],
    ["an id with a space", b64({ createdAt: "2026-01-01T00:00:00.000Z", id: "a b" })],
    ["an id with a NUL", b64({ createdAt: "2026-01-01T00:00:00.000Z", id: "a\u0000b" })],
    ["an empty id", b64({ createdAt: "2026-01-01T00:00:00.000Z", id: "" })],
    ["a numeric id", b64({ createdAt: "2026-01-01T00:00:00.000Z", id: 5 })],
  ])("refuse %s", (_name, cursor) => {
    expect(codeOf(() => decodeCursor(cursor))).toBe("INVALID_INPUT");
  });
});

describe("parseListQuery", () => {
  it("defaults to no filter, no cursor and the default page size", () => {
    expect(parseListQuery({})).toEqual({
      status: null,
      cursor: null,
      limit: LEARNING_PATH_PAGE_SIZE,
    });
    expect(parseListQuery({ status: null, cursor: null, limit: null })).toEqual({
      status: null,
      cursor: null,
      limit: 50,
    });
  });

  it("the page size is 50 and the most is 200", () => {
    expect(LEARNING_PATH_PAGE_SIZE).toBe(50);
    expect(LEARNING_PATH_PAGE_MAX).toBe(200);
  });

  it("takes a limit as a number or a string of digits, capped at the maximum", () => {
    expect(parseListQuery({ limit: "1" }).limit).toBe(1);
    expect(parseListQuery({ limit: 25 }).limit).toBe(25);
    expect(parseListQuery({ limit: "200" }).limit).toBe(200);
    expect(parseListQuery({ limit: "201" }).limit).toBe(200);
    expect(parseListQuery({ limit: 5000 }).limit).toBe(200);
  });

  it.each([0, "0", -1, "-1", "1.5", 1.5, "abc", "1e3", " 5", "５", "1000000000", {}, [], true])(
    "refuses the limit %j",
    (limit) => {
      expect(codeOf(() => parseListQuery({ limit }))).toBe("INVALID_INPUT");
    }
  );

  it("takes each status in any case with surrounding space, and refuses anything else", () => {
    expect(parseListQuery({ status: "draft" }).status).toBe("DRAFT");
    expect(parseListQuery({ status: " Published " }).status).toBe("PUBLISHED");
    expect(parseListQuery({ status: "ARCHIVED" }).status).toBe("ARCHIVED");
    for (const status of ["ALL", "ACTIVE", "DRAFTS", "  ", 1, true, {}]) {
      expect(
        codeOf(() => parseListQuery({ status })),
        String(status)
      ).toBe("INVALID_INPUT");
    }
  });

  it("decodes a cursor and refuses one that is not a string or is malformed", () => {
    const at = new Date("2026-05-06T07:08:09.123Z");

    expect(parseListQuery({ cursor: encodeCursor({ createdAt: at, id: "p1" }) }).cursor).toEqual({
      createdAt: at,
      id: "p1",
    });
    expect(codeOf(() => parseListQuery({ cursor: "junk" }))).toBe("INVALID_INPUT");
    expect(codeOf(() => parseListQuery({ cursor: 5 }))).toBe("INVALID_INPUT");
  });
});
