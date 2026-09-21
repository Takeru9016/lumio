import { describe, expect, it, vi } from "vitest";
import {
  ASSIGNMENTS_API,
  buildAssignBody,
  submitCancellation,
  submitManualAssignment,
} from "./admin-assignment-client";

const response = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

const input = { userId: "u1", courseId: "c1", dueDate: "", note: "" };

describe("buildAssignBody", () => {
  it("sends only the four chosen fields, and omits a blank due date and a blank note", () => {
    expect(buildAssignBody(input)).toEqual({ userId: "u1", courseId: "c1" });
  });

  it("includes a due date and a trimmed note when given", () => {
    expect(buildAssignBody({ ...input, dueDate: "2027-03-01", note: "  hello  " })).toEqual({
      userId: "u1",
      courseId: "c1",
      dueDate: "2027-03-01",
      note: "hello",
    });
  });

  it("treats a whitespace-only note as no note", () => {
    expect(buildAssignBody({ ...input, note: "   \n " })).toEqual({ userId: "u1", courseId: "c1" });
  });

  it("can never carry a tenant, an actor, a source or a key, even if the input object has them", () => {
    const body = buildAssignBody({
      ...input,
      tenantId: "t",
      assignedById: "a",
      source: "CAPABILITY_GAP",
      sourceKey: "k",
    } as never);

    expect(Object.keys(body).sort()).toEqual(["courseId", "userId"]);
  });

  it("never sends a null due date (which would clear an existing one)", () => {
    expect("dueDate" in buildAssignBody(input)).toBe(false);
  });
});

describe("submitManualAssignment", () => {
  it("POSTs JSON to the org endpoint, with no identity in the URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(201, { outcome: "created" }));

    await submitManualAssignment({ ...input, dueDate: "2027-03-01" }, fetchMock);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(ASSIGNMENTS_API);
    expect(String(url)).not.toMatch(/[?&]|tenantId|userId/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ userId: "u1", courseId: "c1", dueDate: "2027-03-01" });
  });

  it.each(["created", "updated", "reactivated", "existing"] as const)(
    "reports the '%s' outcome",
    async (outcome) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(response(outcome === "created" ? 201 : 200, { outcome }));

      expect(await submitManualAssignment(input, fetchMock)).toEqual({ kind: outcome });
    }
  );

  it("shows the server's own message for a refusal", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        response(404, { error: "That learner isn't available to assign learning to." })
      );

    expect(await submitManualAssignment(input, fetchMock)).toEqual({
      kind: "error",
      message: "That learner isn't available to assign learning to.",
    });
  });

  it("uses a generic message when the response carries none, and never raw text", async () => {
    for (const body of [null, {}, { error: 5 }, { error: "" }, { error: "x".repeat(400) }]) {
      const fetchMock = vi.fn().mockResolvedValue(response(500, body));

      const result = await submitManualAssignment(input, fetchMock);

      expect(result).toEqual({
        kind: "error",
        message: "Couldn't assign that course. Please try again.",
      });
    }
  });

  it("treats a network failure, an unreadable body and an unknown outcome as errors, without throwing", async () => {
    const generic = { kind: "error", message: "Couldn't assign that course. Please try again." };

    expect(
      await submitManualAssignment(
        input,
        vi.fn().mockRejectedValue(new TypeError("Failed to fetch"))
      )
    ).toEqual(generic);
    expect(
      await submitManualAssignment(
        input,
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError("x");
          },
        })
      )
    ).toEqual(generic);
    expect(
      await submitManualAssignment(
        input,
        vi.fn().mockResolvedValue(response(200, { outcome: "weird" }))
      )
    ).toEqual(generic);
  });
});

describe("submitCancellation", () => {
  it("POSTs to the cancel endpoint for that assignment, with no body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200, { outcome: "cancelled" }));

    await submitCancellation("asg 1/../x", fetchMock);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/org/assignments/asg%201%2F..%2Fx/cancel");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });

  it.each(["cancelled", "already_cancelled"] as const)("reports '%s'", async (outcome) => {
    const fetchMock = vi.fn().mockResolvedValue(response(200, { outcome }));

    expect(await submitCancellation("a", fetchMock)).toEqual({ kind: outcome });
  });

  it("shows the server's message when the assignment is completed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        response(409, { error: "This assignment is completed, so it can't be cancelled." })
      );

    expect(await submitCancellation("a", fetchMock)).toEqual({
      kind: "error",
      message: "This assignment is completed, so it can't be cancelled.",
    });
  });

  it("uses a generic message for a failure or a network error, without throwing", async () => {
    const generic = {
      kind: "error",
      message: "Couldn't cancel that assignment. Please try again.",
    };

    expect(await submitCancellation("a", vi.fn().mockResolvedValue(response(500, null)))).toEqual(
      generic
    );
    expect(await submitCancellation("a", vi.fn().mockRejectedValue(new Error("offline")))).toEqual(
      generic
    );
    expect(
      await submitCancellation("a", vi.fn().mockResolvedValue(response(200, { outcome: "?" })))
    ).toEqual(generic);
  });
});
