import { auth } from "@clerk/nextjs/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { prerequisiteWorld } from "@/lib/domain/course/__test__/prerequisiteFixtures";
import { POST } from "./route";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));

const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/org/assignments", {
      method: "POST",
      body: JSON.stringify(body),
    })
  );

afterEach(() => {
  vi.mocked(auth).mockReset();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("POST /api/org/assignments — prerequisites", () => {
  it("an unmet prerequisite is a 409 with the stable code and the prerequisites that remain, and creates nothing", async () => {
    const w = await prerequisiteWorld();
    const a = await w.make();
    await w.requires(w.course.id, a.id);
    vi.mocked(auth).mockResolvedValue({ userId: w.admin.user.clerkId } as never);

    const res = await post({ userId: w.learner.user.id, courseId: w.course.id });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "This learner hasn't completed the prerequisite courses for that course yet.",
      code: "PREREQUISITES_NOT_MET",
      prerequisites: [{ courseId: a.id, slug: a.slug, title: a.title }],
    });
    expect(await w.enrollmentCount(w.learner.user.id, w.course.id)).toBe(0);
    expect(await db.learningAssignment.count({ where: { userId: w.learner.user.id } })).toBe(0);
  });

  it("once the prerequisite is completed the same request is created (201)", async () => {
    const w = await prerequisiteWorld();
    const a = await w.make();
    await w.requires(w.course.id, a.id);
    await w.complete(w.learner.user.id, a.id);
    vi.mocked(auth).mockResolvedValue({ userId: w.admin.user.clerkId } as never);

    const res = await post({ userId: w.learner.user.id, courseId: w.course.id });

    expect(res.status).toBe(201);
  });

  it("other refusals keep their bodies: no code or prerequisites are added to them", async () => {
    const w = await prerequisiteWorld();
    vi.mocked(auth).mockResolvedValue({ userId: w.admin.user.clerkId } as never);

    const res = await post({ userId: w.learner.user.id, courseId: "does-not-exist" });

    expect(res.status).toBe(404);
    expect(Object.keys(await res.json())).toEqual(["error"]);
  });
});
