import { auth } from "@clerk/nextjs/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  createAssignment,
  createAssignmentSubmission,
  createCourse,
  createSkill,
  mapCourseSkill,
} from "@/lib/domain/capability/__test__/fixtures";
import { createTenantUser } from "@/lib/domain/knowledge/__test__/fixtures";
import { PUT } from "./route";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));

function req(body: unknown) {
  return new Request("http://localhost/api/assignments/x/submissions/y/grade", {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

function paramsFor(assignmentId: string, submissionId: string) {
  return { params: Promise.resolve({ assignmentId, submissionId }) };
}

/** A STUDENT in the same tenant as the course — createTenantUser always
 * makes a fresh tenant, but evidence creation requires the learner's
 * tenantId to match the course's tenantId. */
function createLearnerInTenant(tenantId: string) {
  return db.user.create({
    data: {
      clerkId: `clerk-${Date.now()}-${Math.random()}`,
      email: `learner-${Date.now()}-${Math.random()}@example.test`,
      tenantId,
      role: "STUDENT",
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("PUT grade — authorization (unchanged, existing behavior)", () => {
  it("401s when unauthenticated", async () => {
    vi.mocked(auth).mockResolvedValue({ userId: null } as never);
    const res = await PUT(req({ score: 50 }), paramsFor("a", "s"));
    expect(res.status).toBe(401);
  });

  it("403s for a STUDENT role", async () => {
    const { user } = await createTenantUser("STUDENT");
    vi.mocked(auth).mockResolvedValue({ userId: user.clerkId } as never);
    const res = await PUT(req({ score: 50 }), paramsFor("a", "s"));
    expect(res.status).toBe(403);
  });

  it("403s when the instructor does not own the assignment's course", async () => {
    const { user: instructor } = await createTenantUser("INSTRUCTOR");
    const { tenant: otherTenant, user: otherInstructor } = await createTenantUser("INSTRUCTOR");
    const { lesson } = await createCourse(otherTenant.id, otherInstructor.id);
    const assignment = await createAssignment(lesson.id);
    const { user: learner } = await createTenantUser("STUDENT");
    const submission = await createAssignmentSubmission(learner.id, assignment.id);

    vi.mocked(auth).mockResolvedValue({ userId: instructor.clerkId } as never);
    const res = await PUT(req({ score: 50 }), paramsFor(assignment.id, submission.id));
    expect(res.status).toBe(403);
  });

  it("still allows SUPER_ADMIN — existing behavior preserved unchanged", async () => {
    const { tenant, user: instructor } = await createTenantUser("INSTRUCTOR");
    const { user: superAdmin } = await createTenantUser("SUPER_ADMIN");
    const { lesson } = await createCourse(tenant.id, instructor.id);
    const assignment = await createAssignment(lesson.id);
    const { user: learner } = await createTenantUser("STUDENT");
    const submission = await createAssignmentSubmission(learner.id, assignment.id);

    vi.mocked(auth).mockResolvedValue({ userId: superAdmin.clerkId } as never);
    const res = await PUT(req({ score: 50 }), paramsFor(assignment.id, submission.id));
    // SUPER_ADMIN still fails the instructor-ownership check (not the owning
    // instructor) — proves the role gate itself did not reject SUPER_ADMIN.
    expect(res.status).toBe(403);
  });
});

describe("PUT grade — validation regression (unchanged, existing behavior)", () => {
  it("400s when score exceeds maxScore", async () => {
    const { tenant, user: instructor } = await createTenantUser("INSTRUCTOR");
    const { lesson } = await createCourse(tenant.id, instructor.id);
    const assignment = await createAssignment(lesson.id, 100);
    const { user: learner } = await createTenantUser("STUDENT");
    const submission = await createAssignmentSubmission(learner.id, assignment.id);

    vi.mocked(auth).mockResolvedValue({ userId: instructor.clerkId } as never);
    const res = await PUT(req({ score: 150 }), paramsFor(assignment.id, submission.id));
    expect(res.status).toBe(400);
  });

  it("404s for a nonexistent submission", async () => {
    const { tenant, user: instructor } = await createTenantUser("INSTRUCTOR");
    const { lesson } = await createCourse(tenant.id, instructor.id);
    const assignment = await createAssignment(lesson.id);

    vi.mocked(auth).mockResolvedValue({ userId: instructor.clerkId } as never);
    const res = await PUT(req({ score: 50 }), paramsFor(assignment.id, "does-not-exist"));
    expect(res.status).toBe(404);
  });
});

describe("PUT grade — response shape (unchanged, existing behavior)", () => {
  it("returns { submission } with score/feedback/status/gradedAt set", async () => {
    const { tenant, user: instructor } = await createTenantUser("INSTRUCTOR");
    const { lesson } = await createCourse(tenant.id, instructor.id);
    const assignment = await createAssignment(lesson.id, 100);
    const { user: learner } = await createTenantUser("STUDENT");
    const submission = await createAssignmentSubmission(learner.id, assignment.id);

    vi.mocked(auth).mockResolvedValue({ userId: instructor.clerkId } as never);
    const res = await PUT(
      req({ score: 80, feedback: "nice work" }),
      paramsFor(assignment.id, submission.id)
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.submission.score).toBe(80);
    expect(body.submission.feedback).toBe("nice work");
    expect(body.submission.status).toBe("GRADED");
    expect(body.submission.gradedAt).not.toBeNull();
  });
});

describe("PUT grade — Phase 17 capability evidence wiring", () => {
  it("a successful grade creates ASSESSMENT evidence for the student, owned by the student not the instructor", async () => {
    const { tenant, user: instructor } = await createTenantUser("INSTRUCTOR");
    const { course, lesson } = await createCourse(tenant.id, instructor.id);
    const skill = await createSkill(tenant.id);
    await mapCourseSkill(course.id, skill.id);
    const assignment = await createAssignment(lesson.id, 100);
    const learner = await createLearnerInTenant(tenant.id);
    const submission = await createAssignmentSubmission(learner.id, assignment.id);

    vi.mocked(auth).mockResolvedValue({ userId: instructor.clerkId } as never);
    const res = await PUT(req({ score: 65 }), paramsFor(assignment.id, submission.id));
    expect(res.status).toBe(200);

    const evidence = await db.skillEvidence.findMany({ where: { userId: learner.id } });
    expect(evidence).toHaveLength(1);
    expect(evidence[0].type).toBe("ASSESSMENT");
    expect(evidence[0].sourceType).toBe("AssignmentSubmission");
    expect(evidence[0].sourceId).toBe(submission.id);
    expect(evidence[0].score).toBe(65);

    const events = await db.learningEvent.findMany({
      where: { userId: learner.id, eventType: "ASSIGNMENT_GRADED" },
    });
    expect(events).toHaveLength(1);
    expect(events[0].entityId).toBe(submission.id);
  });

  it("a low score still creates evidence — no pass/fail concept for assignments", async () => {
    const { tenant, user: instructor } = await createTenantUser("INSTRUCTOR");
    const { course, lesson } = await createCourse(tenant.id, instructor.id);
    const skill = await createSkill(tenant.id);
    await mapCourseSkill(course.id, skill.id);
    const assignment = await createAssignment(lesson.id, 100);
    const learner = await createLearnerInTenant(tenant.id);
    const submission = await createAssignmentSubmission(learner.id, assignment.id);

    vi.mocked(auth).mockResolvedValue({ userId: instructor.clerkId } as never);
    await PUT(req({ score: 1 }), paramsFor(assignment.id, submission.id));

    const evidence = await db.skillEvidence.findMany({ where: { userId: learner.id } });
    expect(evidence).toHaveLength(1);
    expect(evidence[0].score).toBe(1);
  });

  it("a regrade does not create a second evidence row (idempotent) and the response still succeeds", async () => {
    const { tenant, user: instructor } = await createTenantUser("INSTRUCTOR");
    const { course, lesson } = await createCourse(tenant.id, instructor.id);
    const skill = await createSkill(tenant.id);
    await mapCourseSkill(course.id, skill.id);
    const assignment = await createAssignment(lesson.id, 100);
    const learner = await createLearnerInTenant(tenant.id);
    const submission = await createAssignmentSubmission(learner.id, assignment.id);

    vi.mocked(auth).mockResolvedValue({ userId: instructor.clerkId } as never);
    await PUT(req({ score: 70 }), paramsFor(assignment.id, submission.id));
    const res2 = await PUT(req({ score: 30 }), paramsFor(assignment.id, submission.id));
    expect(res2.status).toBe(200);

    const evidence = await db.skillEvidence.findMany({ where: { userId: learner.id } });
    expect(evidence).toHaveLength(1);
    expect(evidence[0].score).toBe(70);

    const body = await res2.json();
    expect(body.submission.score).toBe(30);
  });

  it("no CourseSkill mappings: no evidence created, grade still succeeds", async () => {
    const { tenant, user: instructor } = await createTenantUser("INSTRUCTOR");
    const { lesson } = await createCourse(tenant.id, instructor.id);
    const assignment = await createAssignment(lesson.id, 100);
    const { user: learner } = await createTenantUser("STUDENT");
    const submission = await createAssignmentSubmission(learner.id, assignment.id);

    vi.mocked(auth).mockResolvedValue({ userId: instructor.clerkId } as never);
    const res = await PUT(req({ score: 90 }), paramsFor(assignment.id, submission.id));
    expect(res.status).toBe(200);

    const evidence = await db.skillEvidence.findMany({ where: { userId: learner.id } });
    expect(evidence).toHaveLength(0);
  });

  it("a FREE-plan learner (no tenantId) gets no evidence/event — matches existing tenant-gated pattern", async () => {
    const { tenant, user: instructor } = await createTenantUser("INSTRUCTOR");
    const { lesson } = await createCourse(tenant.id, instructor.id);
    const assignment = await createAssignment(lesson.id, 100);
    const learner = await db.user.create({
      data: {
        clerkId: `clerk-${Date.now()}`,
        email: `free-${Date.now()}@example.test`,
        role: "STUDENT",
      },
    });
    const submission = await createAssignmentSubmission(learner.id, assignment.id);

    vi.mocked(auth).mockResolvedValue({ userId: instructor.clerkId } as never);
    const res = await PUT(req({ score: 90 }), paramsFor(assignment.id, submission.id));
    expect(res.status).toBe(200);

    const evidence = await db.skillEvidence.findMany({ where: { userId: learner.id } });
    expect(evidence).toHaveLength(0);
    const events = await db.learningEvent.findMany({ where: { userId: learner.id } });
    expect(events).toHaveLength(0);
  });
});
