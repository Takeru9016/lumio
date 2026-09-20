import { auth } from "@clerk/nextjs/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CourseStatus, EnrollmentStatus, Role } from "@/generated/prisma/client";
import { db } from "@/lib/db";

/**
 * POST /api/ai/summary against the REAL database. Only the true external
 * boundaries are mocked: Clerk auth, the rate limiter and the LLM call.
 * Every denied case asserts the same four side-effect guarantees: no LLM
 * call, no lesson write, no quota use, and no cached summary in the response.
 */
vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));
vi.mock("@/lib/ratelimit", () => ({
  summaryRatelimit: { limit: vi.fn().mockResolvedValue({ success: true }) },
}));
vi.mock("ai", () => ({ generateText: vi.fn() }));

const { generateText } = await import("ai");
const { summaryRatelimit } = await import("@/lib/ratelimit");
const { POST } = await import("./route");

const generateTextMock = vi.mocked(generateText);
const limitMock = vi.mocked(summaryRatelimit.limit);

const CACHED = "CACHED-SECRET-SUMMARY";

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

function createTenant() {
  return db.tenant.create({ data: { name: unique("tenant"), slug: unique("tenant-slug") } });
}

function makeUser(opts: { tenantId: string | null; role?: Role; plan?: "FREE" | "STARTER" }) {
  return db.user.create({
    data: {
      clerkId: unique("clerk"),
      email: `${unique("user")}@example.test`,
      tenantId: opts.tenantId,
      role: opts.role ?? "STUDENT",
      plan: opts.plan ?? "STARTER",
    },
  });
}

type LessonSeed = {
  tenantId: string | null;
  courseStatus?: CourseStatus;
  isPublished?: boolean;
  isArchived?: boolean;
  isFree?: boolean;
  aiSummary?: string | null;
};

async function seedLesson(opts: LessonSeed) {
  const instructor = await makeUser({ tenantId: opts.tenantId, role: "INSTRUCTOR" });
  const course = await db.course.create({
    data: {
      title: unique("course"),
      slug: unique("course-slug"),
      instructorId: instructor.id,
      tenantId: opts.tenantId,
      status: opts.courseStatus ?? "PUBLISHED",
    },
  });
  const section = await db.section.create({
    data: { title: unique("section"), order: 0, courseId: course.id },
  });
  const lesson = await db.lesson.create({
    data: {
      title: unique("lesson"),
      slug: unique("lesson-slug"),
      type: "TEXT",
      order: 0,
      sectionId: section.id,
      textContent: "<p>The body of the lesson.</p>",
      isPublished: opts.isPublished ?? true,
      isArchived: opts.isArchived ?? false,
      isFree: opts.isFree ?? false,
      aiSummary: opts.aiSummary === undefined ? CACHED : opts.aiSummary,
    },
  });
  return { instructor, course, lesson };
}

function enroll(userId: string, courseId: string, status: EnrollmentStatus = "ACTIVE") {
  return db.enrollment.create({ data: { userId, courseId, status } });
}

function callAs(clerkId: string | null, body: unknown) {
  vi.mocked(auth).mockResolvedValue({ userId: clerkId } as never);
  return POST(
    new Request("http://localhost/api/ai/summary", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  );
}

async function expectNoSideEffects(
  lessonId: string,
  userId: string,
  expectedSummary: string | null
) {
  expect(generateTextMock).not.toHaveBeenCalled();
  const lesson = await db.lesson.findUniqueOrThrow({ where: { id: lessonId } });
  expect(lesson.aiSummary).toBe(expectedSummary);
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  expect(user.aiCallsUsed).toBe(0);
}

beforeEach(() => {
  generateTextMock.mockReset();
  generateTextMock.mockResolvedValue({ text: "- one\n- two\n- three" } as never);
  limitMock.mockReset();
  limitMock.mockResolvedValue({ success: true } as never);
});

afterEach(() => {
  vi.mocked(auth).mockReset();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("POST /api/ai/summary — request guards (unchanged)", () => {
  it("401s when unauthenticated", async () => {
    const res = await callAs(null, { lessonId: "x" });
    expect(res.status).toBe(401);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("429s when rate limited, before any lesson work", async () => {
    const tenant = await createTenant();
    const user = await makeUser({ tenantId: tenant.id });
    limitMock.mockResolvedValueOnce({ success: false } as never);

    const res = await callAs(user.clerkId, { lessonId: "x" });

    expect(res.status).toBe(429);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("403s with upgradeRequired when the AI quota is exhausted", async () => {
    const tenant = await createTenant();
    const { lesson } = await seedLesson({ tenantId: tenant.id, isFree: true });
    const user = await makeUser({ tenantId: tenant.id, plan: "FREE" });

    const res = await callAs(user.clerkId, { lessonId: lesson.id });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ upgradeRequired: true });
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("400s on invalid JSON", async () => {
    const tenant = await createTenant();
    const user = await makeUser({ tenantId: tenant.id });
    const res = await callAs(user.clerkId, "{not json");
    expect(res.status).toBe(400);
  });

  it.each([
    ["missing lessonId", {}],
    ["empty lessonId", { lessonId: "" }],
    ["numeric lessonId", { lessonId: 12 }],
    ["an object lessonId (would be a Prisma filter)", { lessonId: { startsWith: "" } }],
    ["a null body", "null"],
  ])("400s on %s without any lookup or LLM call", async (_label, body) => {
    const tenant = await createTenant();
    const user = await makeUser({ tenantId: tenant.id });

    const res = await callAs(user.clerkId, body);

    expect(res.status).toBe(400);
    expect(generateTextMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/ai/summary — denied (404): hidden or missing content", () => {
  type Scenario = {
    label: string;
    build: () => Promise<{ userClerkId: string; userId: string; lessonId: string }>;
  };

  const scenarios: Scenario[] = [
    {
      label: "free lesson in a DRAFT course (not enrolled)",
      build: async () => {
        const tenant = await createTenant();
        const { lesson } = await seedLesson({
          tenantId: tenant.id,
          courseStatus: "DRAFT",
          isFree: true,
        });
        const user = await makeUser({ tenantId: tenant.id });
        return { userClerkId: user.clerkId, userId: user.id, lessonId: lesson.id };
      },
    },
    {
      label: "free lesson in an ARCHIVED course (not enrolled)",
      build: async () => {
        const tenant = await createTenant();
        const { lesson } = await seedLesson({
          tenantId: tenant.id,
          courseStatus: "ARCHIVED",
          isFree: true,
        });
        const user = await makeUser({ tenantId: tenant.id });
        return { userClerkId: user.clerkId, userId: user.id, lessonId: lesson.id };
      },
    },
    {
      label: "unpublished free lesson (not enrolled)",
      build: async () => {
        const tenant = await createTenant();
        const { lesson } = await seedLesson({
          tenantId: tenant.id,
          isFree: true,
          isPublished: false,
        });
        const user = await makeUser({ tenantId: tenant.id });
        return { userClerkId: user.clerkId, userId: user.id, lessonId: lesson.id };
      },
    },
    {
      label: "archived free lesson (not enrolled)",
      build: async () => {
        const tenant = await createTenant();
        const { lesson } = await seedLesson({
          tenantId: tenant.id,
          isFree: true,
          isArchived: true,
        });
        const user = await makeUser({ tenantId: tenant.id });
        return { userClerkId: user.clerkId, userId: user.id, lessonId: lesson.id };
      },
    },
    {
      label: "cross-tenant free lesson",
      build: async () => {
        const ownerTenant = await createTenant();
        const otherTenant = await createTenant();
        const { lesson } = await seedLesson({ tenantId: ownerTenant.id, isFree: true });
        const user = await makeUser({ tenantId: otherTenant.id });
        return { userClerkId: user.clerkId, userId: user.id, lessonId: lesson.id };
      },
    },
    {
      label: "tenantless user against a tenant-owned free lesson",
      build: async () => {
        const ownerTenant = await createTenant();
        const { lesson } = await seedLesson({ tenantId: ownerTenant.id, isFree: true });
        const user = await makeUser({ tenantId: null });
        return { userClerkId: user.clerkId, userId: user.id, lessonId: lesson.id };
      },
    },
    {
      label: "cross-tenant paid lesson (not enrolled)",
      build: async () => {
        const ownerTenant = await createTenant();
        const otherTenant = await createTenant();
        const { lesson } = await seedLesson({ tenantId: ownerTenant.id, isFree: false });
        const user = await makeUser({ tenantId: otherTenant.id });
        return { userClerkId: user.clerkId, userId: user.id, lessonId: lesson.id };
      },
    },
    {
      label: "enrolled learner, but the course is DRAFT",
      build: async () => {
        const tenant = await createTenant();
        const { course, lesson } = await seedLesson({ tenantId: tenant.id, courseStatus: "DRAFT" });
        const user = await makeUser({ tenantId: tenant.id });
        await enroll(user.id, course.id);
        return { userClerkId: user.clerkId, userId: user.id, lessonId: lesson.id };
      },
    },
    {
      label: "enrolled learner, but the lesson is unpublished",
      build: async () => {
        const tenant = await createTenant();
        const { course, lesson } = await seedLesson({ tenantId: tenant.id, isPublished: false });
        const user = await makeUser({ tenantId: tenant.id });
        await enroll(user.id, course.id);
        return { userClerkId: user.clerkId, userId: user.id, lessonId: lesson.id };
      },
    },
    {
      label: "enrolled learner, but the lesson is archived",
      build: async () => {
        const tenant = await createTenant();
        const { course, lesson } = await seedLesson({ tenantId: tenant.id, isArchived: true });
        const user = await makeUser({ tenantId: tenant.id });
        await enroll(user.id, course.id);
        return { userClerkId: user.clerkId, userId: user.id, lessonId: lesson.id };
      },
    },
    {
      label: "REFUNDED enrollment on a lesson that is otherwise hidden",
      build: async () => {
        const tenant = await createTenant();
        const { course, lesson } = await seedLesson({ tenantId: tenant.id, isPublished: false });
        const user = await makeUser({ tenantId: tenant.id });
        await enroll(user.id, course.id, "REFUNDED");
        return { userClerkId: user.clerkId, userId: user.id, lessonId: lesson.id };
      },
    },
  ];

  it.each(scenarios)(
    "404s: $label — no LLM call, no write, no quota use, no cached summary",
    async ({ build }) => {
      const { userClerkId, userId, lessonId } = await build();

      const res = await callAs(userClerkId, { lessonId });
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body).toEqual({ error: "Lesson not found" });
      expect(JSON.stringify(body)).not.toContain(CACHED);
      await expectNoSideEffects(lessonId, userId, CACHED);
    }
  );

  it("returns the identical 404 for a missing lesson and for hidden lessons", async () => {
    const tenant = await createTenant();
    const user = await makeUser({ tenantId: tenant.id });
    const { lesson: draftLesson } = await seedLesson({
      tenantId: tenant.id,
      courseStatus: "DRAFT",
      isFree: true,
    });

    const missing = await callAs(user.clerkId, { lessonId: "does-not-exist" });
    const hidden = await callAs(user.clerkId, { lessonId: draftLesson.id });

    expect(missing.status).toBe(404);
    expect(hidden.status).toBe(404);
    expect(await missing.json()).toEqual(await hidden.json());
  });
});

describe("POST /api/ai/summary — denied (403): visible but requires enrollment", () => {
  it("403s a non-enrolled user on a published paid lesson in their own tenant", async () => {
    const tenant = await createTenant();
    const { lesson } = await seedLesson({ tenantId: tenant.id, isFree: false });
    const user = await makeUser({ tenantId: tenant.id });

    const res = await callAs(user.clerkId, { lessonId: lesson.id });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body).toEqual({ error: "Not enrolled in this course" });
    await expectNoSideEffects(lesson.id, user.id, CACHED);
  });

  it("403s a non-enrolled tenantless user on a paid lesson in a tenantless course", async () => {
    const { lesson } = await seedLesson({ tenantId: null, isFree: false });
    const user = await makeUser({ tenantId: null });

    const res = await callAs(user.clerkId, { lessonId: lesson.id });

    expect(res.status).toBe(403);
    await expectNoSideEffects(lesson.id, user.id, CACHED);
  });

  it("does not let a REFUNDED enrollment unlock a paid lesson", async () => {
    const tenant = await createTenant();
    const { course, lesson } = await seedLesson({ tenantId: tenant.id, isFree: false });
    const user = await makeUser({ tenantId: tenant.id });
    await enroll(user.id, course.id, "REFUNDED");

    const res = await callAs(user.clerkId, { lessonId: lesson.id });

    expect(res.status).toBe(403);
    await expectNoSideEffects(lesson.id, user.id, CACHED);
  });
});

describe("POST /api/ai/summary — no role shortcuts", () => {
  it.each(["INSTRUCTOR", "ORG_ADMIN", "SUPER_ADMIN"] as const)(
    "a %s in the course's tenant is denied a paid lesson without enrollment (403)",
    async (role) => {
      const tenant = await createTenant();
      const { lesson } = await seedLesson({ tenantId: tenant.id, isFree: false });
      const user = await makeUser({ tenantId: tenant.id, role });

      const res = await callAs(user.clerkId, { lessonId: lesson.id });

      expect(res.status).toBe(403);
      await expectNoSideEffects(lesson.id, user.id, CACHED);
    }
  );

  it("the course's own instructor is denied a DRAFT course's free lesson (404)", async () => {
    const tenant = await createTenant();
    const { instructor, lesson } = await seedLesson({
      tenantId: tenant.id,
      courseStatus: "DRAFT",
      isFree: true,
    });

    const res = await callAs(instructor.clerkId, { lessonId: lesson.id });

    expect(res.status).toBe(404);
    await expectNoSideEffects(lesson.id, instructor.id, CACHED);
  });

  it("a SUPER_ADMIN is denied another tenant's free lesson (404)", async () => {
    const ownerTenant = await createTenant();
    const { lesson } = await seedLesson({ tenantId: ownerTenant.id, isFree: true });
    const superAdmin = await makeUser({ tenantId: null, role: "SUPER_ADMIN" });

    const res = await callAs(superAdmin.clerkId, { lessonId: lesson.id });

    expect(res.status).toBe(404);
    await expectNoSideEffects(lesson.id, superAdmin.id, CACHED);
  });
});

describe("POST /api/ai/summary — allowed", () => {
  async function expectGenerated(res: Response, lessonId: string, userId: string) {
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ summary: "- one\n- two\n- three" });
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    const call = generateTextMock.mock.calls[0][0] as { system: string };
    expect(call.system).toContain("The body of the lesson.");
    const lesson = await db.lesson.findUniqueOrThrow({ where: { id: lessonId } });
    expect(lesson.aiSummary).toBe("- one\n- two\n- three");
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.aiCallsUsed).toBe(1);
  }

  it("a same-tenant free lesson without enrollment generates, caches and counts usage", async () => {
    const tenant = await createTenant();
    const { lesson } = await seedLesson({ tenantId: tenant.id, isFree: true, aiSummary: null });
    const user = await makeUser({ tenantId: tenant.id });

    const res = await callAs(user.clerkId, { lessonId: lesson.id });

    await expectGenerated(res, lesson.id, user.id);
  });

  it("a tenantless course's free lesson is available to a tenantless user", async () => {
    const { lesson } = await seedLesson({ tenantId: null, isFree: true, aiSummary: null });
    const user = await makeUser({ tenantId: null });

    const res = await callAs(user.clerkId, { lessonId: lesson.id });

    await expectGenerated(res, lesson.id, user.id);
  });

  it("a tenantless course's free lesson is available to a tenanted user", async () => {
    const tenant = await createTenant();
    const { lesson } = await seedLesson({ tenantId: null, isFree: true, aiSummary: null });
    const user = await makeUser({ tenantId: tenant.id });

    const res = await callAs(user.clerkId, { lessonId: lesson.id });

    await expectGenerated(res, lesson.id, user.id);
  });

  it.each(["ACTIVE", "COMPLETED"] as const)(
    "an %s enrollment on a published paid lesson generates a summary",
    async (status) => {
      const tenant = await createTenant();
      const { course, lesson } = await seedLesson({
        tenantId: tenant.id,
        isFree: false,
        aiSummary: null,
      });
      const user = await makeUser({ tenantId: tenant.id });
      await enroll(user.id, course.id, status);

      const res = await callAs(user.clerkId, { lessonId: lesson.id });

      await expectGenerated(res, lesson.id, user.id);
    }
  );

  it("an enrolled learner keeps access to a published lesson in an ARCHIVED course (player parity)", async () => {
    const tenant = await createTenant();
    const { course, lesson } = await seedLesson({
      tenantId: tenant.id,
      courseStatus: "ARCHIVED",
      aiSummary: null,
    });
    const user = await makeUser({ tenantId: tenant.id });
    await enroll(user.id, course.id);

    const res = await callAs(user.clerkId, { lessonId: lesson.id });

    await expectGenerated(res, lesson.id, user.id);
  });

  it("enrollment is the entitlement: an enrolled learner in another tenant's course is served", async () => {
    const ownerTenant = await createTenant();
    const otherTenant = await createTenant();
    const { course, lesson } = await seedLesson({ tenantId: ownerTenant.id, aiSummary: null });
    const user = await makeUser({ tenantId: otherTenant.id });
    await enroll(user.id, course.id);

    const res = await callAs(user.clerkId, { lessonId: lesson.id });

    await expectGenerated(res, lesson.id, user.id);
  });

  it("returns the cached summary only after authorization, with no LLM call and no quota use", async () => {
    const tenant = await createTenant();
    const { course, lesson } = await seedLesson({ tenantId: tenant.id });
    const user = await makeUser({ tenantId: tenant.id });
    await enroll(user.id, course.id);

    const res = await callAs(user.clerkId, { lessonId: lesson.id });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ summary: CACHED });
    await expectNoSideEffects(lesson.id, user.id, CACHED);
  });

  it("502s and writes nothing when the model fails", async () => {
    const tenant = await createTenant();
    const { lesson } = await seedLesson({ tenantId: tenant.id, isFree: true, aiSummary: null });
    const user = await makeUser({ tenantId: tenant.id });
    generateTextMock.mockRejectedValueOnce(new Error("provider exploded"));

    const res = await callAs(user.clerkId, { lessonId: lesson.id });

    expect(res.status).toBe(502);
    const stored = await db.lesson.findUniqueOrThrow({ where: { id: lesson.id } });
    expect(stored.aiSummary).toBeNull();
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.aiCallsUsed).toBe(0);
  });
});
