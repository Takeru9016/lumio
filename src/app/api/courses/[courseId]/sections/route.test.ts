import { describe, expect, it } from "vitest";

describe("/api/courses/[courseId]/sections", () => {
  it("no longer exports an unauthenticated-content GET (removed in Phase 23; it had no callers)", async () => {
    const mod = await import("./route");

    expect((mod as Record<string, unknown>).GET).toBeUndefined();
  });

  it("still exports POST (instructor section creation is used by CourseEditor)", async () => {
    const mod = await import("./route");

    expect(typeof mod.POST).toBe("function");
  });
});
