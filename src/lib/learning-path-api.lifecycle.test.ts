import { describe, expect, it } from "vitest";
import { readEmptyBody } from "@/lib/learning-path-api";

const request = (body?: string) => new Request("http://x", { method: "POST", body });

describe("readEmptyBody", () => {
  it.each([undefined, "", "   ", "\n", "{}", " { } ", "{\n}"])(
    "accepts the body %j",
    async (body) => {
      await expect(readEmptyBody(request(body))).resolves.toBeUndefined();
    }
  );

  it.each([
    '{"status":"PUBLISHED"}',
    '{"publishedAt":"2026-01-01T00:00:00.000Z"}',
    '{"tenantId":"t"}',
    '{"a":null}',
    "[]",
    "[1]",
    "null",
    "0",
    '"x"',
    "true",
    "{",
    "not json",
  ])("refuses the body %s with INVALID_INPUT", async (body) => {
    await expect(readEmptyBody(request(body))).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
