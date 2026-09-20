import { auth } from "@clerk/nextjs/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  createAssignment,
  createAssignmentSubmission,
  createCourse,
} from "@/lib/domain/capability/__test__/fixtures";
import { createUserInTenant } from "@/lib/domain/course/__test__/fixtures";
import { createTenantUser } from "@/lib/domain/knowledge/__test__/fixtures";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));

let mockObjectResult: { suggestedScore: number; feedback: string; rationale: string } | null = {
  suggestedScore: 70,
  feedback: "Solid attempt.",
  rationale: "Meets most of the brief.",
};
let mockShouldThrow = false;

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    generateObject: vi.fn().mockImplementation(async () => {
      if (mockShouldThrow) throw new Error("provider exploded");
      return { object: mockObjectResult, usage: { inputTokens: 5, outputTokens: 5 } };
    }),
  };
});

vi.mock("@/lib/ratelimit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ratelimit")>("@/lib/ratelimit");
  return {
    ...actual,
    assessmentRatelimit: { limit: vi.fn().mockResolvedValue({ success: true }) },
  };
});

const { generateObject } = await import("ai");
const { POST } = await import("./route");

// AI quota defaults to the FREE plan's 0 calls/month (see src/constants/plans.ts)
// — every acting user in this file needs a paid plan so the quota gate
// itself (unrelated to what each test actually verifies) doesn't 403 first.
async function createProUser(role: Parameters<typeof createTenantUser>[0] = "INSTRUCTOR") {
  const result = await createTenantUser(role);
  await db.user.update({ where: { id: result.user.id }, data: { plan: "PRO" } });
  return result;
}

function req() {
  return new Request("http://localhost/api/ai/assignments/x/submissions/y/suggest-grade", {
    method: "POST",
  });
}

function paramsFor(assignmentId: string, submissionId: string) {
  return { params: Promise.resolve({ assignmentId, submissionId }) };
}

afterEach(() => {
  vi.restoreAllMocks();
  mockObjectResult = {
    suggestedScore: 70,
    feedback: "Solid attempt.",
    rationale: "Meets most of the brief.",
  };
  mockShouldThrow = false;
});

afterAll(async () => {
  await db.$disconnect();
});

describe("POST suggest-grade — authorization", () => {
  it("401s when unauthenticated", async () => {
    vi.mocked(auth).mockResolvedValue({ userId: null } as never);
    const res = await POST(req(), paramsFor("a", "s"));
    expect(res.status).toBe(401);
  });

  it("403s for a STUDENT role", async () => {
    const { user } = await createProUser("STUDENT");
    vi.mocked(auth).mockResolvedValue({ userId: user.clerkId } as never);
    const res = await POST(req(), paramsFor("a", "s"));
    expect(res.status).toBe(403);
  });

  it("403s when the instructor does not own the assignment's course", async () => {
    const { user: instructor } = await createProUser("INSTRUCTOR");
    const { tenant: otherTenant, user: otherInstructor } = await createProUser("INSTRUCTOR");
    const { lesson } = await createCourse(otherTenant.id, otherInstructor.id);
    const assignment = await createAssignment(lesson.id);
    const { user: learner } = await createProUser("STUDENT");
    const submission = await createAssignmentSubmission(learner.id, assignment.id);

    vi.mocked(auth).mockResolvedValue({ userId: instructor.clerkId } as never);
    const res = await POST(req(), paramsFor(assignment.id, submission.id));
    expect(res.status).toBe(403);
  });

  it("403s an ORG_ADMIN, even one in the course's own tenant", async () => {
    const { tenant, user: instructor } = await createProUser("INSTRUCTOR");
    const { lesson } = await createCourse(tenant.id, instructor.id);
    const assignment = await createAssignment(lesson.id);
    const { user: learner } = await createProUser("STUDENT");
    const submission = await createAssignmentSubmission(learner.id, assignment.id);
    const orgAdmin = await createUserInTenant(tenant.id, "ORG_ADMIN");
    await db.user.update({ where: { id: orgAdmin.id }, data: { plan: "PRO" } });

    vi.mocked(auth).mockResolvedValue({ userId: orgAdmin.clerkId } as never);
    const res = await POST(req(), paramsFor(assignment.id, submission.id));

    expect(res.status).toBe(403);
    expect(vi.mocked(generateObject)).not.toHaveBeenCalled();
  });
});

describe("POST suggest-grade — SUPER_ADMIN is not authorized to grade", () => {
  it("403s a SUPER_ADMIN before any LLM call, AIExecution, usage event or quota use", async () => {
    vi.mocked(generateObject).mockClear();
    const { tenant, user: instructor } = await createProUser("INSTRUCTOR");
    const { lesson } = await createCourse(tenant.id, instructor.id);
    const assignment = await createAssignment(lesson.id);
    const { user: learner } = await createProUser("STUDENT");
    const submission = await createAssignmentSubmission(learner.id, assignment.id);
    const superAdmin = await createUserInTenant(tenant.id, "SUPER_ADMIN");
    await db.user.update({ where: { id: superAdmin.id }, data: { plan: "PRO" } });

    vi.mocked(auth).mockResolvedValue({ userId: superAdmin.clerkId } as never);
    const res = await POST(req(), paramsFor(assignment.id, submission.id));

    expect(res.status).toBe(403);
    expect(vi.mocked(generateObject)).not.toHaveBeenCalled();
    expect(await db.aIExecution.count({ where: { userId: superAdmin.id } })).toBe(0);
    expect(await db.aIUsageEvent.count({ where: { userId: superAdmin.id } })).toBe(0);
    const after = await db.user.findUniqueOrThrow({ where: { id: superAdmin.id } });
    expect(after.aiCallsUsed).toBe(0);
  });

  it("leaves the submission, evidence, events and notifications untouched", async () => {
    const { tenant, user: instructor } = await createProUser("INSTRUCTOR");
    const { course, lesson } = await createCourse(tenant.id, instructor.id);
    const skill = await db.skill.create({
      data: { tenantId: tenant.id, name: "sg", slug: `sg-${Date.now()}` },
    });
    await db.courseSkill.create({ data: { courseId: course.id, skillId: skill.id } });
    const assignment = await createAssignment(lesson.id);
    const { user: learner } = await createProUser("STUDENT");
    const submission = await createAssignmentSubmission(learner.id, assignment.id);
    const superAdmin = await createUserInTenant(tenant.id, "SUPER_ADMIN");
    await db.user.update({ where: { id: superAdmin.id }, data: { plan: "PRO" } });

    vi.mocked(auth).mockResolvedValue({ userId: superAdmin.clerkId } as never);
    const res = await POST(req(), paramsFor(assignment.id, submission.id));
    expect(res.status).toBe(403);

    const reloaded = await db.assignmentSubmission.findUniqueOrThrow({
      where: { id: submission.id },
    });
    expect(reloaded.status).toBe("SUBMITTED");
    expect(reloaded.score).toBeNull();
    expect(await db.skillEvidence.count({ where: { userId: learner.id } })).toBe(0);
    expect(await db.learningEvent.count({ where: { userId: learner.id } })).toBe(0);
    expect(await db.notification.count({ where: { userId: learner.id } })).toBe(0);
  });

  it("403s a SUPER_ADMIN even when it is the course's recorded owner, with no LLM call or quota use", async () => {
    vi.mocked(generateObject).mockClear();
    const { tenant } = await createProUser("INSTRUCTOR");
    const superAdmin = await createUserInTenant(tenant.id, "SUPER_ADMIN");
    await db.user.update({ where: { id: superAdmin.id }, data: { plan: "PRO" } });
    const { lesson } = await createCourse(tenant.id, superAdmin.id);
    const assignment = await createAssignment(lesson.id);
    const { user: learner } = await createProUser("STUDENT");
    const submission = await createAssignmentSubmission(learner.id, assignment.id);

    vi.mocked(auth).mockResolvedValue({ userId: superAdmin.clerkId } as never);
    const res = await POST(req(), paramsFor(assignment.id, submission.id));

    expect(res.status).toBe(403);
    expect(vi.mocked(generateObject)).not.toHaveBeenCalled();
    expect(await db.aIExecution.count({ where: { userId: superAdmin.id } })).toBe(0);
    const after = await db.user.findUniqueOrThrow({ where: { id: superAdmin.id } });
    expect(after.aiCallsUsed).toBe(0);
  });

  it("denies a SUPER_ADMIN at the role gate, before the assignment lookup (no existence probe)", async () => {
    const { user: superAdmin } = await createProUser("SUPER_ADMIN");

    vi.mocked(auth).mockResolvedValue({ userId: superAdmin.clerkId } as never);
    const res = await POST(req(), paramsFor("does-not-exist", "nor-this"));

    expect(res.status).toBe(403);
  });
});

describe("POST suggest-grade — input", () => {
  it("404s for an unknown assignment", async () => {
    const { user: instructor } = await createProUser("INSTRUCTOR");
    vi.mocked(auth).mockResolvedValue({ userId: instructor.clerkId } as never);
    const res = await POST(req(), paramsFor("does-not-exist", "s"));
    expect(res.status).toBe(404);
  });

  it("404s for an unknown submission", async () => {
    const { tenant, user: instructor } = await createProUser("INSTRUCTOR");
    const { lesson } = await createCourse(tenant.id, instructor.id);
    const assignment = await createAssignment(lesson.id);
    vi.mocked(auth).mockResolvedValue({ userId: instructor.clerkId } as never);
    const res = await POST(req(), paramsFor(assignment.id, "does-not-exist"));
    expect(res.status).toBe(404);
  });

  it("404s for a submission belonging to a different assignment", async () => {
    const { tenant, user: instructor } = await createProUser("INSTRUCTOR");
    const { lesson: lessonA } = await createCourse(tenant.id, instructor.id);
    const { lesson: lessonB } = await createCourse(tenant.id, instructor.id);
    const assignmentA = await createAssignment(lessonA.id);
    const assignmentB = await createAssignment(lessonB.id);
    const { user: learner } = await createProUser("STUDENT");
    const submission = await createAssignmentSubmission(learner.id, assignmentA.id);

    vi.mocked(auth).mockResolvedValue({ userId: instructor.clerkId } as never);
    const res = await POST(req(), paramsFor(assignmentB.id, submission.id));
    expect(res.status).toBe(404);
  });

  it("accepts an empty/missing body", async () => {
    const { tenant, user: instructor } = await createProUser("INSTRUCTOR");
    const { lesson } = await createCourse(tenant.id, instructor.id);
    const assignment = await createAssignment(lesson.id);
    const { user: learner } = await createProUser("STUDENT");
    const submission = await createAssignmentSubmission(learner.id, assignment.id);

    vi.mocked(auth).mockResolvedValue({ userId: instructor.clerkId } as never);
    const res = await POST(req(), paramsFor(assignment.id, submission.id));
    expect(res.status).toBe(200);
  });

  it("422s when the submission has no text and no file", async () => {
    const { tenant, user: instructor } = await createProUser("INSTRUCTOR");
    const { lesson } = await createCourse(tenant.id, instructor.id);
    const assignment = await createAssignment(lesson.id);
    const { user: learner } = await createProUser("STUDENT");
    const submission = await db.assignmentSubmission.create({
      data: { userId: learner.id, assignmentId: assignment.id, status: "SUBMITTED" },
    });

    vi.mocked(auth).mockResolvedValue({ userId: instructor.clerkId } as never);
    const res = await POST(req(), paramsFor(assignment.id, submission.id));
    expect(res.status).toBe(422);
  });

  it("client body content is ignored — identifiers come from the path only", async () => {
    const { tenant, user: instructor } = await createProUser("INSTRUCTOR");
    const { lesson } = await createCourse(tenant.id, instructor.id);
    const assignment = await createAssignment(lesson.id);
    const { user: learner } = await createProUser("STUDENT");
    const submission = await createAssignmentSubmission(learner.id, assignment.id);

    vi.mocked(auth).mockResolvedValue({ userId: instructor.clerkId } as never);
    const forgedBody = new Request(
      "http://localhost/api/ai/assignments/x/submissions/y/suggest-grade",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          score: 999,
          maxScore: 1,
          tenantId: "other-tenant",
          userId: "other-user",
        }),
      }
    );
    const res = await POST(forgedBody, paramsFor(assignment.id, submission.id));
    expect(res.status).toBe(200);
  });
});

describe("POST suggest-grade — AI output", () => {
  it("returns 200 with the exact draft shape for a valid generateObject result", async () => {
    const { tenant, user: instructor } = await createProUser("INSTRUCTOR");
    const { lesson } = await createCourse(tenant.id, instructor.id);
    const assignment = await createAssignment(lesson.id, 100);
    const { user: learner } = await createProUser("STUDENT");
    const submission = await createAssignmentSubmission(learner.id, assignment.id);

    vi.mocked(auth).mockResolvedValue({ userId: instructor.clerkId } as never);
    const res = await POST(req(), paramsFor(assignment.id, submission.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      suggestedScore: 70,
      feedback: "Solid attempt.",
      rationale: "Meets most of the brief.",
      citations: [],
    });
  });

  it("502s when the mocked model returns a negative score", async () => {
    mockObjectResult = { suggestedScore: -5, feedback: "x", rationale: "y" };
    const { tenant, user: instructor } = await createProUser("INSTRUCTOR");
    const { lesson } = await createCourse(tenant.id, instructor.id);
    const assignment = await createAssignment(lesson.id, 100);
    const { user: learner } = await createProUser("STUDENT");
    const submission = await createAssignmentSubmission(learner.id, assignment.id);

    vi.mocked(auth).mockResolvedValue({ userId: instructor.clerkId } as never);
    const res = await POST(req(), paramsFor(assignment.id, submission.id));
    expect(res.status).toBe(502);
  });

  it("502s when the mocked model returns a score above maxScore", async () => {
    mockObjectResult = { suggestedScore: 999, feedback: "x", rationale: "y" };
    const { tenant, user: instructor } = await createProUser("INSTRUCTOR");
    const { lesson } = await createCourse(tenant.id, instructor.id);
    const assignment = await createAssignment(lesson.id, 100);
    const { user: learner } = await createProUser("STUDENT");
    const submission = await createAssignmentSubmission(learner.id, assignment.id);

    vi.mocked(auth).mockResolvedValue({ userId: instructor.clerkId } as never);
    const res = await POST(req(), paramsFor(assignment.id, submission.id));
    expect(res.status).toBe(502);
  });

  it("502s when the mocked model returns a non-integer score", async () => {
    mockObjectResult = { suggestedScore: 55.5, feedback: "x", rationale: "y" };
    const { tenant, user: instructor } = await createProUser("INSTRUCTOR");
    const { lesson } = await createCourse(tenant.id, instructor.id);
    const assignment = await createAssignment(lesson.id, 100);
    const { user: learner } = await createProUser("STUDENT");
    const submission = await createAssignmentSubmission(learner.id, assignment.id);

    vi.mocked(auth).mockResolvedValue({ userId: instructor.clerkId } as never);
    const res = await POST(req(), paramsFor(assignment.id, submission.id));
    expect(res.status).toBe(502);
  });

  it("502s when the AI provider throws", async () => {
    mockShouldThrow = true;
    const { tenant, user: instructor } = await createProUser("INSTRUCTOR");
    const { lesson } = await createCourse(tenant.id, instructor.id);
    const assignment = await createAssignment(lesson.id, 100);
    const { user: learner } = await createProUser("STUDENT");
    const submission = await createAssignmentSubmission(learner.id, assignment.id);

    vi.mocked(auth).mockResolvedValue({ userId: instructor.clerkId } as never);
    const res = await POST(req(), paramsFor(assignment.id, submission.id));
    expect(res.status).toBe(502);
  });

  it("marks the AIExecution FAILED on provider failure", async () => {
    mockShouldThrow = true;
    const { tenant, user: instructor } = await createProUser("INSTRUCTOR");
    const { lesson } = await createCourse(tenant.id, instructor.id);
    const assignment = await createAssignment(lesson.id, 100);
    const { user: learner } = await createProUser("STUDENT");
    const submission = await createAssignmentSubmission(learner.id, assignment.id);

    vi.mocked(auth).mockResolvedValue({ userId: instructor.clerkId } as never);
    await POST(req(), paramsFor(assignment.id, submission.id));

    const executions = await db.aIExecution.findMany({
      where: { userId: instructor.id, operation: "assessment.suggest-grade" },
    });
    expect(executions).toHaveLength(1);
    expect(executions[0].status).toBe("FAILED");
  });
});

describe("POST suggest-grade — non-mutation (critical)", () => {
  it("calling suggest-grade alone never mutates AssignmentSubmission or creates evidence/events", async () => {
    const { tenant, user: instructor } = await createProUser("INSTRUCTOR");
    const { course, lesson } = await createCourse(tenant.id, instructor.id);
    const assignment = await createAssignment(lesson.id, 100);
    const { user: learner } = await createProUser("STUDENT");
    const submission = await createAssignmentSubmission(learner.id, assignment.id);
    await db.courseSkill.create({
      data: {
        courseId: course.id,
        skillId: (
          await db.skill.create({
            data: { tenantId: tenant.id, name: "x", slug: `x-${Date.now()}` },
          })
        ).id,
      },
    });

    vi.mocked(auth).mockResolvedValue({ userId: instructor.clerkId } as never);
    const res = await POST(req(), paramsFor(assignment.id, submission.id));
    expect(res.status).toBe(200);

    const reloaded = await db.assignmentSubmission.findUniqueOrThrow({
      where: { id: submission.id },
    });
    expect(reloaded.score).toBeNull();
    expect(reloaded.status).toBe("SUBMITTED");
    expect(reloaded.gradedAt).toBeNull();
    expect(reloaded.feedback).toBeNull();

    const evidence = await db.skillEvidence.findMany({ where: { userId: learner.id } });
    expect(evidence).toHaveLength(0);
    const userSkills = await db.userSkill.findMany({ where: { userId: learner.id } });
    expect(userSkills).toHaveLength(0);
    const events = await db.learningEvent.findMany({ where: { userId: learner.id } });
    expect(events).toHaveLength(0);
  });
});

describe("POST suggest-grade — runtime", () => {
  it("records AIExecution/AIUsageEvent on success", async () => {
    const { tenant, user: instructor } = await createProUser("INSTRUCTOR");
    const { lesson } = await createCourse(tenant.id, instructor.id);
    const assignment = await createAssignment(lesson.id, 100);
    const { user: learner } = await createProUser("STUDENT");
    const submission = await createAssignmentSubmission(learner.id, assignment.id);

    vi.mocked(auth).mockResolvedValue({ userId: instructor.clerkId } as never);
    await POST(req(), paramsFor(assignment.id, submission.id));

    const executions = await db.aIExecution.findMany({
      where: { userId: instructor.id, operation: "assessment.suggest-grade" },
    });
    expect(executions).toHaveLength(1);
    expect(executions[0].status).toBe("SUCCEEDED");

    const usageEvents = await db.aIUsageEvent.findMany({
      where: { userId: instructor.id, operation: "assessment.suggest-grade" },
    });
    expect(usageEvents).toHaveLength(1);
  });

  it("429s when rate limited", async () => {
    const { assessmentRatelimit } = await import("@/lib/ratelimit");
    vi.mocked(assessmentRatelimit.limit).mockResolvedValueOnce({ success: false } as never);
    const { user: instructor } = await createProUser("INSTRUCTOR");
    vi.mocked(auth).mockResolvedValue({ userId: instructor.clerkId } as never);
    const res = await POST(req(), paramsFor("a", "s"));
    expect(res.status).toBe(429);
  });

  it("403s with quota body when AI quota is exhausted", async () => {
    const { user: instructor } = await createProUser("INSTRUCTOR");
    await db.user.update({ where: { id: instructor.id }, data: { aiCallsUsed: 10_000 } });
    vi.mocked(auth).mockResolvedValue({ userId: instructor.clerkId } as never);
    const res = await POST(req(), paramsFor("a", "s"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.upgradeRequired).toBe(true);
  });
});
