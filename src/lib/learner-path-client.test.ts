import { describe, expect, it, vi } from "vitest";

import { learnerListUrl, loadLearnerPath, loadLearnerPaths } from "@/lib/learner-path-client";

const answer = (status: number, body: unknown) =>
  vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status })
  );

describe("learner path requests", () => {
  it("reads the list from /api/paths, with the cursor and nothing else", async () => {
    const fetchImpl = answer(200, { paths: [], hasMore: false, nextCursor: null });

    await loadLearnerPaths(null, fetchImpl);
    await loadLearnerPaths("a b+c", fetchImpl);

    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual([
      "/api/paths",
      "/api/paths?cursor=a%20b%2Bc",
    ]);
    expect(learnerListUrl(null)).toBe("/api/paths");
  });

  it("reads one path from one request, encoding its id", async () => {
    const fetchImpl = answer(200, { path: { id: "p", courses: [] } });

    const result = await loadLearnerPath("a/b", fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe("/api/paths/a%2Fb");
    expect(result).toEqual({ kind: "ready", data: { id: "p", courses: [] } });
  });

  it("is one not-found for a path that is missing, unpublished or another organisation's", async () => {
    expect(await loadLearnerPath("p", answer(404, { error: "Learning path not found" }))).toEqual({
      kind: "not_found",
    });
  });

  it("puts each failure into words and never shows the server's text", async () => {
    const errors = [
      [401, /session/],
      [403, /learners in an organisation/],
      [400, /learners in an organisation/],
      [500, /went wrong while loading/],
    ] as const;
    for (const [status, pattern] of errors) {
      const result = await loadLearnerPaths(null, answer(status, { error: "SECRET server text" }));
      expect(result.kind).toBe("error");
      if (result.kind === "error") {
        expect(result.message).toMatch(pattern);
        expect(result.message).not.toContain("SECRET");
      }
    }
  });

  it("treats a network failure as an error result, not an exception", async () => {
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect((await loadLearnerPath("p", offline)).kind).toBe("error");
    expect((await loadLearnerPaths(null, offline)).kind).toBe("error");
  });

  it("treats a cursor the server refuses as a stale link, not a broken page", async () => {
    expect(await loadLearnerPaths("old", answer(400, { error: "Invalid cursor" }))).toEqual({
      kind: "not_found",
    });
  });

  it("lets an aborted read propagate so a superseded read is never mistaken for a failure", async () => {
    const controller = new AbortController();
    const aborting = vi.fn(async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    await expect(loadLearnerPath("p", aborting, controller.signal)).rejects.toThrow();
  });
});
