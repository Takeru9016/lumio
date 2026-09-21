import { afterEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { AuthContextError } from "@/lib/auth/context";
import {
  fail,
  LearningPathError,
  type LearningPathErrorCode,
  PathNotPublishableError,
} from "@/lib/domain/learning-path/types";
import { pathErrorResponse, readJsonBody } from "@/lib/learning-path-api";

afterEach(() => {
  vi.restoreAllMocks();
});

const EXPECTED: Record<LearningPathErrorCode, number> = {
  INVALID_INPUT: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  COURSE_NOT_FOUND: 404,
  INVALID_TRANSITION: 409,
  PATH_ARCHIVED: 409,
  COURSE_ARCHIVED: 409,
  DUPLICATE: 409,
  LIMIT_REACHED: 409,
  LAST_COURSE: 409,
  PATH_NOT_PUBLISHABLE: 409,
  STALE_ORDER: 409,
};

describe("pathErrorResponse", () => {
  it.each(Object.entries(EXPECTED))("answers %s with %i and its code", async (code, status) => {
    const res = pathErrorResponse(
      new LearningPathError(code as LearningPathErrorCode, "Prose"),
      "label",
      "public"
    );

    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: "Prose", code });
  });

  it("answers the real domain errors with their real messages", async () => {
    for (const make of Object.values(fail).filter((f) => f.length === 0)) {
      const err = (make as () => LearningPathError)();
      const res = pathErrorResponse(err, "label", "public");
      expect(res.status).toBe(EXPECTED[err.code]);
      expect(await res.json()).toEqual({ error: err.message, code: err.code });
    }
  });

  it("keeps the status and message of an auth failure", async () => {
    for (const status of [400, 401, 403] as const) {
      const res = pathErrorResponse(new AuthContextError(status, "Nope"), "label", "public");
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error: "Nope" });
    }
  });

  it("tells an administrator which courses block a path, and not the title of one from another tenant", async () => {
    const res = pathErrorResponse(
      new PathNotPublishableError([
        { kind: "INVALID_TITLE" },
        { kind: "NO_COURSES" },
        { kind: "COURSE", courseId: "c1", title: "Mine", reason: "ARCHIVED" },
        { kind: "COURSE", courseId: "c2", title: "Secret title", reason: "WRONG_TENANT" },
      ]),
      "label",
      "public"
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({
      error: "The path can't be published yet",
      code: "PATH_NOT_PUBLISHABLE",
      problems: [
        { kind: "INVALID_TITLE" },
        { kind: "NO_COURSES" },
        { kind: "COURSE", courseId: "c1", title: "Mine", reason: "ARCHIVED" },
        { kind: "COURSE", courseId: "c2", reason: "WRONG_TENANT" },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("Secret title");
  });

  it.each([
    ["a plain error", new Error('relation "LearningPath" does not exist')],
    [
      "a database error",
      new Prisma.PrismaClientKnownRequestError("Unique constraint on LearningPathCourse_pathId", {
        code: "P2002",
        clientVersion: "test",
      }),
    ],
    ["a thrown string", "tenant tenant_123 leaked"],
  ])("answers %s with a generic 500 and puts nothing internal in the body", async (_name, err) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = pathErrorResponse(err, "Failed to do it", "Couldn't do that");
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: "Couldn't do that" });
    expect(text).not.toMatch(/LearningPath|tenant|P2002|relation/);
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe("readJsonBody", () => {
  it("returns the parsed JSON", async () => {
    expect(
      await readJsonBody(new Request("http://x", { method: "POST", body: '{"a":1}' }))
    ).toEqual({
      a: 1,
    });
  });

  it.each(["", "not json", "{"])("turns %j into INVALID_INPUT", async (body) => {
    await expect(
      readJsonBody(new Request("http://x", { method: "POST", body }))
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });
});
