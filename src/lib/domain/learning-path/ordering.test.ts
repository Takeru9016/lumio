import { describe, expect, it } from "vitest";
import {
  nextPosition,
  planReorder,
  positionsAfterRemoval,
  renumber,
  sortMembers,
} from "@/lib/domain/learning-path/ordering";
import { LearningPathError } from "@/lib/domain/learning-path/types";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof LearningPathError) return err.code;
    throw err;
  }
  return "OK";
}

const m = (courseId: string, position: number) => ({ courseId, position });

describe("nextPosition", () => {
  it("starts at 1 for an empty path", () => {
    expect(nextPosition([])).toBe(1);
  });

  it("is max + 1", () => {
    expect(nextPosition([1, 2, 3])).toBe(4);
    expect(nextPosition([3, 1, 2])).toBe(4);
  });

  it("is max + 1 even when positions have gaps or ties", () => {
    expect(nextPosition([1, 5, 9])).toBe(10);
    expect(nextPosition([2, 2, 2])).toBe(3);
  });

  it("never returns a position an existing member holds", () => {
    const positions = [1, 4, 4, 7];
    expect(positions).not.toContain(nextPosition(positions));
  });
});

describe("sortMembers", () => {
  it("orders by position, and ties by course id so the order is deterministic", () => {
    expect(sortMembers([m("c", 2), m("b", 1), m("a", 1)]).map((x) => x.courseId)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("does not modify its input", () => {
    const input = [m("b", 2), m("a", 1)];
    sortMembers(input);
    expect(input.map((x) => x.courseId)).toEqual(["b", "a"]);
  });
});

describe("renumber", () => {
  it("assigns exactly 1..n, keeping the relative order", () => {
    expect(renumber([m("a", 1), m("b", 4), m("c", 9)])).toEqual([m("a", 1), m("b", 2), m("c", 3)]);
  });

  it("closes gaps and resolves ties deterministically", () => {
    expect(renumber([m("z", 5), m("y", 5), m("x", 1)])).toEqual([m("x", 1), m("y", 2), m("z", 3)]);
  });

  it("an empty path renumbers to nothing", () => {
    expect(renumber([])).toEqual([]);
  });
});

describe("positionsAfterRemoval", () => {
  it("drops the course and renumbers the rest to 1..n-1", () => {
    expect(positionsAfterRemoval([m("a", 1), m("b", 2), m("c", 3)], "b")).toEqual([
      m("a", 1),
      m("c", 2),
    ]);
  });

  it("removing the first or last also leaves 1..n-1", () => {
    expect(positionsAfterRemoval([m("a", 1), m("b", 2)], "a")).toEqual([m("b", 1)]);
    expect(positionsAfterRemoval([m("a", 1), m("b", 2)], "b")).toEqual([m("a", 1)]);
  });

  it("removing the only course leaves nothing", () => {
    expect(positionsAfterRemoval([m("a", 1)], "a")).toEqual([]);
  });

  it("removing a course that is not there changes nothing but renumbers", () => {
    expect(positionsAfterRemoval([m("a", 3), m("b", 8)], "nope")).toEqual([m("a", 1), m("b", 2)]);
  });
});

describe("planReorder", () => {
  const current = ["a", "b", "c"];

  it("the exact same set in a new order yields positions 1..n in that order", () => {
    expect(planReorder(current, ["c", "a", "b"])).toEqual([m("c", 1), m("a", 2), m("b", 3)]);
  });

  it("the same order is a valid, idempotent request", () => {
    expect(planReorder(current, ["a", "b", "c"])).toEqual([m("a", 1), m("b", 2), m("c", 3)]);
  });

  it("a missing course means the client's view is out of date: STALE_ORDER", () => {
    expect(codeOf(() => planReorder(current, ["a", "b"]))).toBe("STALE_ORDER");
  });

  it("an unknown course means the same: STALE_ORDER", () => {
    expect(codeOf(() => planReorder(current, ["a", "b", "c", "d"]))).toBe("STALE_ORDER");
    expect(codeOf(() => planReorder(current, ["a", "b", "x"]))).toBe("STALE_ORDER");
  });

  it("a duplicate is malformed, not stale: INVALID_INPUT", () => {
    expect(codeOf(() => planReorder(current, ["a", "a", "b", "c"]))).toBe("INVALID_INPUT");
    expect(codeOf(() => planReorder(current, ["a", "b", "b"]))).toBe("INVALID_INPUT");
  });

  it("an empty set is INVALID_INPUT, even for an empty path", () => {
    expect(codeOf(() => planReorder(current, []))).toBe("INVALID_INPUT");
    expect(codeOf(() => planReorder([], []))).toBe("INVALID_INPUT");
  });

  it.each([undefined, null, "a,b,c", 5, {}, [1, 2, 3], [null], [""], ["a b"], [["a"]]])(
    "a malformed request (%j) is INVALID_INPUT",
    (requested) => {
      expect(codeOf(() => planReorder(current, requested))).toBe("INVALID_INPUT");
    }
  );

  it("client-supplied positions cannot be smuggled in: objects are refused", () => {
    expect(codeOf(() => planReorder(current, [{ courseId: "a", position: 99 }]))).toBe(
      "INVALID_INPUT"
    );
  });

  it("does not modify either input", () => {
    const requested = ["c", "b", "a"];
    planReorder(current, requested);
    expect(current).toEqual(["a", "b", "c"]);
    expect(requested).toEqual(["c", "b", "a"]);
  });

  it("malformed is decided before stale: a request that is both is INVALID_INPUT", () => {
    expect(codeOf(() => planReorder(current, ["a", "a"]))).toBe("INVALID_INPUT");
  });
});
