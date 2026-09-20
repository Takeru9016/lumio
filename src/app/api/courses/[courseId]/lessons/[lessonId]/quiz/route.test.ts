import { auth } from "@clerk/nextjs/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { createCourse } from "@/lib/domain/capability/__test__/fixtures";
import { createTenantUser } from "@/lib/domain/knowledge/__test__/fixtures";

/**
 * POST /api/courses/[courseId]/lessons/[lessonId]/quiz — the only place a quiz's
 * attempt limit is set. Real database; only Clerk is mocked.
 */
vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));

const { POST } = await import("./route");

afterEach(() => {
  vi.mocked(auth).mockReset();
});

afterAll(async () => {
  await db.$disconnect();
});

const question = {
  question: "Q?",
  type: "TRUE_FALSE",
  correctAnswer: "true",
  order: 0,
};

async function setup() {
  const { tenant, user: instructor } = await createTenantUser("INSTRUCTOR");
  const { course, lesson } = await createCourse(tenant.id, instructor.id);
  return { instructor, course, lesson };
}

function save(
  s: { course: { slug: string }; lesson: { id: string } },
  clerkId: string,
  body: Record<string, unknown>
) {
  vi.mocked(auth).mockResolvedValue({ userId: clerkId } as never);
  return POST(new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) }), {
    params: Promise.resolve({ courseId: s.course.slug, lessonId: s.lesson.id }),
  });
}

const stored = (lessonId: string) => db.quiz.findUniqueOrThrow({ where: { lessonId } });

describe("quiz save — maxAttempts validation", () => {
  it.each([
    ["zero", 0],
    ["a negative number", -1],
    ["a fraction", 1.5],
    ["a string", "3"],
    ["a boolean", true],
    ["above the ceiling", 1001],
  ])("rejects %s with 400 and saves nothing", async (_label, value) => {
    const s = await setup();

    const res = await save(s, s.instructor.clerkId, { questions: [question], maxAttempts: value });

    expect(res.status).toBe(400);
    expect(await db.quiz.count({ where: { lessonId: s.lesson.id } })).toBe(0);
  });

  it("stores a positive whole number", async () => {
    const s = await setup();

    const res = await save(s, s.instructor.clerkId, { questions: [question], maxAttempts: 3 });

    expect(res.status).toBe(200);
    expect((await stored(s.lesson.id)).maxAttempts).toBe(3);
    expect((await res.json()).quiz.maxAttempts).toBe(3);
  });

  it("defaults to unlimited (null) when never set", async () => {
    const s = await setup();

    await save(s, s.instructor.clerkId, { questions: [question] });

    expect((await stored(s.lesson.id)).maxAttempts).toBeNull();
  });

  it("keeps the limit when a later save omits it, and clears it only for an explicit null", async () => {
    const s = await setup();
    await save(s, s.instructor.clerkId, { questions: [question], maxAttempts: 2 });

    await save(s, s.instructor.clerkId, { questions: [question], title: "Renamed" });
    expect((await stored(s.lesson.id)).maxAttempts).toBe(2);

    await save(s, s.instructor.clerkId, { questions: [question], maxAttempts: null });
    expect((await stored(s.lesson.id)).maxAttempts).toBeNull();
  });

  it("an invalid value on an existing quiz leaves its limit unchanged", async () => {
    const s = await setup();
    await save(s, s.instructor.clerkId, { questions: [question], maxAttempts: 4 });

    const res = await save(s, s.instructor.clerkId, { questions: [question], maxAttempts: 0 });

    expect(res.status).toBe(400);
    expect((await stored(s.lesson.id)).maxAttempts).toBe(4);
  });

  it("only the course's instructor can set it", async () => {
    const s = await setup();
    const { user: stranger } = await createTenantUser("INSTRUCTOR");

    const res = await save(s, stranger.clerkId, { questions: [question], maxAttempts: 1 });

    expect(res.status).toBe(403);
    expect(await db.quiz.count({ where: { lessonId: s.lesson.id } })).toBe(0);
  });
});
