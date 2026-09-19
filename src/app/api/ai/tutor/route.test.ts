import { auth } from "@clerk/nextjs/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { createCourse } from "@/lib/domain/capability/__test__/fixtures";
import { createUserInTenant } from "@/lib/domain/course/__test__/fixtures";
import { createTenantUser } from "@/lib/domain/knowledge/__test__/fixtures";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));
vi.mock("@/lib/ratelimit", () => ({ tutorRatelimit: {} }));
vi.mock("@/lib/ai/middleware", () => ({ withAiGuards: vi.fn() }));
vi.mock("@/lib/ai/search", () => ({ searchSimilarLessons: vi.fn() }));
vi.mock("@/lib/ai/runtime/context", () => ({ buildAIContext: vi.fn() }));
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    streamText: vi.fn(() => {
      throw new Error("stop-after-retrieval");
    }),
  };
});

const { withAiGuards } = await import("@/lib/ai/middleware");
const { searchSimilarLessons } = await import("@/lib/ai/search");
const { buildAIContext } = await import("@/lib/ai/runtime/context");
const { POST } = await import("./route");

const searchMock = vi.mocked(searchSimilarLessons);
const contextMock = vi.mocked(buildAIContext);

const messages = [{ id: "m1", role: "user", parts: [{ type: "text", text: "explain this" }] }];

async function post(clerkId: string, body: Record<string, unknown>) {
  vi.mocked(auth).mockResolvedValue({ userId: clerkId } as never);
  vi.mocked(withAiGuards).mockImplementation(async (id) => {
    const user = await db.user.findUnique({ where: { clerkId: id as string } });
    return { ok: true, user: user as never };
  });
  try {
    return await POST(
      new Request("http://localhost/api/ai/tutor", {
        method: "POST",
        body: JSON.stringify({ messages, ...body }),
      })
    );
  } catch (err) {
    if ((err as Error).message !== "stop-after-retrieval") throw err;
    return null;
  }
}

async function enrolledStudent() {
  const { tenant, user: instructor } = await createTenantUser("INSTRUCTOR");
  const student = await createUserInTenant(tenant.id, "STUDENT");
  const courseA = await createCourse(tenant.id, instructor.id);
  await db.enrollment.create({ data: { userId: student.id, courseId: courseA.course.id } });
  return { tenant, instructor, student, courseA };
}

beforeEach(() => {
  searchMock.mockReset();
  searchMock.mockResolvedValue([]);
  contextMock.mockReset();
  contextMock.mockResolvedValue({ knowledge: [] } as never);
});

afterEach(() => {
  vi.mocked(auth).mockReset();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("POST /api/ai/tutor — legacy retrieval scope is server-derived", () => {
  it("enrolled in A + lesson A + correct courseId A -> retrieval scoped to A", async () => {
    const { student, courseA } = await enrolledStudent();

    await post(student.clerkId, { lessonId: courseA.lesson.id, courseId: courseA.course.id });

    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(searchMock.mock.calls[0][1]).toBe(courseA.course.id);
  });

  it("enrolled in A + lesson A + FOREIGN courseId B in the body -> still scoped to A", async () => {
    const { student, courseA } = await enrolledStudent();
    const { tenant: otherTenant, user: otherInstructor } = await createTenantUser("INSTRUCTOR");
    const courseB = await createCourse(otherTenant.id, otherInstructor.id);

    await post(student.clerkId, { lessonId: courseA.lesson.id, courseId: courseB.course.id });

    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(searchMock.mock.calls[0][1]).toBe(courseA.course.id);
    expect(searchMock.mock.calls[0][1]).not.toBe(courseB.course.id);
    expect(contextMock.mock.calls[0][0].courseId).toBe(courseA.course.id);
  });

  it("enrolled in A + lesson A + courseId OMITTED -> scoped to A, never global", async () => {
    const { student, courseA } = await enrolledStudent();

    await post(student.clerkId, { lessonId: courseA.lesson.id });

    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(searchMock.mock.calls[0][1]).toBe(courseA.course.id);
  });

  it("the persisted conversation records the server-derived course, not the body's", async () => {
    const { student, courseA } = await enrolledStudent();

    await post(student.clerkId, { lessonId: courseA.lesson.id, courseId: "attacker-supplied" });

    const conversation = await db.aIConversation.findFirst({
      where: { userId: student.id },
      orderBy: { createdAt: "desc" },
    });
    expect(conversation?.contextMetadata).toMatchObject({
      lessonId: courseA.lesson.id,
      courseId: courseA.course.id,
    });
  });

  it("a lesson from another tenant/course the student is not enrolled in -> 403 before any retrieval", async () => {
    const { student } = await enrolledStudent();
    const { tenant: otherTenant, user: otherInstructor } = await createTenantUser("INSTRUCTOR");
    const foreign = await createCourse(otherTenant.id, otherInstructor.id);

    const res = await post(student.clerkId, {
      lessonId: foreign.lesson.id,
      courseId: foreign.course.id,
    });

    expect(res?.status).toBe(403);
    expect(searchMock).not.toHaveBeenCalled();
    expect(contextMock).not.toHaveBeenCalled();
  });

  it("an enrollment that is not ACTIVE/COMPLETED does not authorize the lesson", async () => {
    const { student, courseA } = await enrolledStudent();
    await db.enrollment.updateMany({
      where: { userId: student.id },
      data: { status: "REFUNDED" },
    });

    const res = await post(student.clerkId, { lessonId: courseA.lesson.id });

    expect(res?.status).toBe(403);
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("a standalone chat (no lessonId) never runs legacy retrieval, even with a foreign courseId in the body", async () => {
    const { student } = await enrolledStudent();
    const { tenant: otherTenant, user: otherInstructor } = await createTenantUser("INSTRUCTOR");
    const foreign = await createCourse(otherTenant.id, otherInstructor.id);

    await post(student.clerkId, { courseId: foreign.course.id });

    expect(searchMock).not.toHaveBeenCalled();
    expect(contextMock).not.toHaveBeenCalled();
  });

  it("a body courseId never reaches the AI request context for a standalone chat", async () => {
    const { student } = await enrolledStudent();

    await post(student.clerkId, { courseId: "attacker-supplied" });

    expect(contextMock).not.toHaveBeenCalled();
  });
});
