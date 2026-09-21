import { describe, expect, it, vi } from "vitest";

import {
  addCourse,
  archivePath,
  createPath,
  describeFailure,
  listUrl,
  loadAdminPath,
  loadAdminPaths,
  publishPath,
  removeCourse,
  reorderCourses,
  updatePath,
} from "@/lib/admin-path-client";
import type { ApiFailure } from "@/lib/path-request";

const answer = (status: number, body: unknown) =>
  vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status })
  );

const failure = (over: Partial<ApiFailure>): ApiFailure => ({
  kind: "error",
  status: 409,
  code: null,
  serverMessage: null,
  problems: [],
  ...over,
});

describe("requests", () => {
  it("builds the list url from the status and cursor only", () => {
    expect(listUrl({ status: null, cursor: null })).toBe("/api/org/paths");
    expect(listUrl({ status: "DRAFT", cursor: null })).toBe("/api/org/paths?status=DRAFT");
    expect(listUrl({ status: "ARCHIVED", cursor: "x y" })).toBe(
      "/api/org/paths?status=ARCHIVED&cursor=x+y"
    );
  });

  it("uses one endpoint per change, with the method it needs", async () => {
    const fetchImpl = answer(200, { path: {} });

    await createPath({ title: "T", description: "" }, fetchImpl);
    await updatePath("p/1", { title: "T", description: "D" }, fetchImpl);
    await addCourse("p/1", "c/1", fetchImpl);
    await removeCourse("p/1", "c/1", fetchImpl);
    await reorderCourses("p/1", ["b", "a"], fetchImpl);
    await publishPath("p/1", fetchImpl);
    await archivePath("p/1", fetchImpl);

    expect(fetchImpl.mock.calls.map(([url, init]) => [init?.method, url])).toEqual([
      ["POST", "/api/org/paths"],
      ["PATCH", "/api/org/paths/p%2F1"],
      ["POST", "/api/org/paths/p%2F1/courses"],
      ["DELETE", "/api/org/paths/p%2F1/courses/c%2F1"],
      ["POST", "/api/org/paths/p%2F1/reorder"],
      ["POST", "/api/org/paths/p%2F1/publish"],
      ["POST", "/api/org/paths/p%2F1/archive"],
    ]);
  });

  it("sends the complete list of ids to reorder, never positions", async () => {
    const fetchImpl = answer(200, { path: {} });
    await reorderCourses("p", ["b", "a", "c"], fetchImpl);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({
      courseIds: ["b", "a", "c"],
    });
  });

  it("sends no body for publish and archive, and no extra fields for the rest", async () => {
    const fetchImpl = answer(200, { path: {} });
    await publishPath("p", fetchImpl);
    await archivePath("p", fetchImpl);
    await addCourse("p", "c", fetchImpl);
    await createPath({ title: "T", description: "  " }, fetchImpl);

    expect(fetchImpl.mock.calls.map(([, init]) => init?.body ?? null)).toEqual([
      null,
      null,
      JSON.stringify({ courseId: "c" }),
      JSON.stringify({ title: "T", description: null }),
    ]);
  });

  it("returns the server's path on success", async () => {
    const path = { id: "p", title: "T" };
    expect(await createPath({ title: "T", description: "" }, answer(201, { path }))).toEqual({
      kind: "ok",
      data: path,
    });
  });

  it("reads one path from one request and maps 404 to not-found", async () => {
    const fetchImpl = answer(404, { error: "Learning path not found", code: "NOT_FOUND" });
    expect(await loadAdminPath("p", fetchImpl)).toEqual({ kind: "not_found" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("maps a refused cursor to a stale link but any other list failure to an error", async () => {
    expect(
      await loadAdminPaths(
        { status: null, cursor: "old" },
        answer(400, { error: "Invalid cursor" })
      )
    ).toEqual({ kind: "not_found" });
    expect((await loadAdminPaths({ status: null, cursor: null }, answer(500, {}))).kind).toBe(
      "error"
    );
  });

  it("answers a network failure with words and no exception", async () => {
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const result = await publishPath("p", offline);
    expect(result.kind === "error" && result.failure).toMatchObject({
      status: null,
      message: "Couldn't reach the server. Check your connection and try again.",
      refresh: false,
    });
  });
});

describe("describeFailure", () => {
  const words = (over: Partial<ApiFailure>, intent: "read" | "change" | "publish" = "change") =>
    describeFailure(failure(over), intent);

  it.each([
    ["NOT_FOUND", 404, /isn't available/],
    ["COURSE_NOT_FOUND", 404, /couldn't be found in your organisation/],
    ["INVALID_TRANSITION", 409, /can't change to that status/],
    ["PATH_ARCHIVED", 409, /archived.*Republish/],
    ["COURSE_ARCHIVED", 409, /Archived courses/],
    ["DUPLICATE", 409, /already in this path/],
    ["LAST_COURSE", 409, /at least one course/],
    ["STALE_ORDER", 409, /current order/],
  ])("%s becomes fixed words", (code, status, pattern) => {
    const result = words({ code, status });
    expect(result.message).toMatch(pattern);
    expect(result.message).not.toContain(code);
  });

  it("passes on the domain's own short validation prose, and only for validation", () => {
    expect(
      words({
        code: "INVALID_INPUT",
        status: 400,
        serverMessage: "Title must be between 1 and 100 characters",
      }).message
    ).toBe("Title must be between 1 and 100 characters");
    expect(
      words({ code: "LIMIT_REACHED", serverMessage: "A path can have at most 20 courses" }).message
    ).toBe("A path can have at most 20 courses");
    expect(words({ code: "DUPLICATE", serverMessage: "server text" }).message).not.toContain(
      "server text"
    );
    expect(words({ code: "INVALID_INPUT", status: 400 }).message).toBe(
      "Check the details and try again."
    );
  });

  it("words a publishability refusal by what was being attempted", () => {
    expect(words({ code: "PATH_NOT_PUBLISHABLE" }, "publish").message).toBe(
      "This path can't be published yet."
    );
    expect(words({ code: "PATH_NOT_PUBLISHABLE" }, "change").message).toMatch(
      /unable to be published/
    );
  });

  it("carries the blocking courses through untouched", () => {
    const problems = [{ kind: "COURSE", courseId: "c", title: "T", reason: "ARCHIVED" }];
    expect(words({ code: "PATH_NOT_PUBLISHABLE", problems }).problems).toBe(problems);
  });

  it("asks for a re-read on 404 and 409, and on nothing else", () => {
    const refresh = (status: number | null) => words({ status }).refresh;
    expect([404, 409].map(refresh)).toEqual([true, true]);
    expect([400, 401, 403, 500, null].map(refresh)).toEqual([false, false, false, false, false]);
  });

  it("words authorization and infrastructure answers without a code", () => {
    const status = (n: number) =>
      words({ status: n, code: null, serverMessage: "Forbidden" }).message;
    expect(status(401)).toMatch(/session has ended/);
    expect(status(403)).toMatch(/permission/);
    expect(status(500)).toBe("Something went wrong. Please try again.");
    expect(status(500)).not.toContain("Forbidden");
  });

  it("never shows a raw error code or enum", () => {
    const codes = [
      "FORBIDDEN",
      "NOT_FOUND",
      "INVALID_INPUT",
      "INVALID_TRANSITION",
      "PATH_ARCHIVED",
      "COURSE_NOT_FOUND",
      "COURSE_ARCHIVED",
      "DUPLICATE",
      "LIMIT_REACHED",
      "LAST_COURSE",
      "PATH_NOT_PUBLISHABLE",
      "STALE_ORDER",
    ];
    for (const code of codes) {
      const message = words({ code, status: 409, serverMessage: null }).message;
      expect(message, code).not.toMatch(/[A-Z]{3,}_[A-Z]{3,}/);
    }
  });
});
