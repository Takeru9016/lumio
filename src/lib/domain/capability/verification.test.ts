import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  createAssignment,
  createAssignmentSubmission,
  createCourse,
  createJobRole,
  createQuiz,
  createQuizAttempt,
  createRoleSkill,
  createSkill,
  createUserJobRole,
} from "@/lib/domain/capability/__test__/fixtures";
import { computeCapabilityGap } from "@/lib/domain/capability/gaps";
import {
  CapabilityVerificationError,
  getReviewableEvidenceForInstructor,
  rejectEvidence,
  verifyEvidence,
} from "@/lib/domain/capability/verification";
import { createTenantUser } from "@/lib/domain/knowledge/__test__/fixtures";

afterAll(async () => {
  await db.$disconnect();
});

async function createCourseSourcedEvidence(params: {
  tenantId: string;
  userId: string;
  skillId: string;
  courseId: string;
}) {
  return db.skillEvidence.create({
    data: {
      tenantId: params.tenantId,
      userId: params.userId,
      skillId: params.skillId,
      type: "COURSE_COMPLETION",
      sourceType: "Course",
      sourceId: params.courseId,
    },
  });
}

describe("verifyEvidence / rejectEvidence — authorization", () => {
  it("the learner who owns the evidence cannot verify their own evidence", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);
    const evidence = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: course.id,
    });

    // The learner attempting to act on their own evidence.
    const selfCtx = { ...learnerCtx, tenantId: tenant.id };
    await expect(verifyEvidence(selfCtx, evidence.id)).rejects.toThrow(CapabilityVerificationError);
    await expect(rejectEvidence(selfCtx, evidence.id)).rejects.toThrow(CapabilityVerificationError);
  });

  it("an instructor who does not own the source course is rejected", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: otherInstructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);
    const evidence = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: course.id,
    });

    const actorCtx = { ...otherInstructorCtx, tenantId: tenant.id };
    await expect(verifyEvidence(actorCtx, evidence.id)).rejects.toThrow(
      CapabilityVerificationError
    );
  });

  it("the owning instructor can verify — sets VERIFIED, verifiedById, verifiedAt, and raises proficiency to exactly INTERMEDIATE", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);
    const evidence = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: course.id,
    });

    const actorCtx = { ...instructorCtx, tenantId: tenant.id };
    const userSkill = await verifyEvidence(actorCtx, evidence.id);

    expect(userSkill.proficiency).toBe("INTERMEDIATE");

    const updated = await db.skillEvidence.findUniqueOrThrow({ where: { id: evidence.id } });
    expect(updated.verificationStatus).toBe("VERIFIED");
    expect(updated.verifiedById).toBe(instructorCtx.userId);
    expect(updated.verifiedAt).not.toBeNull();
  });

  it("the owning instructor can reject", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);
    const evidence = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: course.id,
    });

    const actorCtx = { ...instructorCtx, tenantId: tenant.id };
    const userSkill = await rejectEvidence(actorCtx, evidence.id);

    expect(userSkill.proficiency).toBe("NONE");
    const updated = await db.skillEvidence.findUniqueOrThrow({ where: { id: evidence.id } });
    expect(updated.verificationStatus).toBe("REJECTED");
  });

  it("verification never writes confidence (locked contract — no confidence semantics in Phase 5)", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);
    const evidence = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: course.id,
    });

    const actorCtx = { ...instructorCtx, tenantId: tenant.id };
    const verified = await verifyEvidence(actorCtx, evidence.id);
    expect(verified.confidence).toBeNull();

    const rejected = await rejectEvidence(actorCtx, evidence.id);
    expect(rejected.confidence).toBeNull();
  });

  it("SUPER_ADMIN can verify evidence for a course they do not own", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: adminCtx } = await createTenantUser("SUPER_ADMIN");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);
    const evidence = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: course.id,
    });

    const actorCtx = { ...adminCtx, tenantId: tenant.id };
    const userSkill = await verifyEvidence(actorCtx, evidence.id);
    expect(userSkill.proficiency).toBe("INTERMEDIATE");
  });

  it("SUPER_ADMIN is still denied when the evidence's source cannot be resolved (fails closed, not an unconditional bypass)", async () => {
    const { tenant } = await createTenantUser("INSTRUCTOR");
    const { ctx: adminCtx } = await createTenantUser("SUPER_ADMIN");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const skill = await createSkill(tenant.id);
    // No Course/QuizAttempt exists for this source — an unrecognized/
    // unresolvable sourceType, same as a future evidence type this
    // authorization logic hasn't been extended for yet.
    const evidence = await db.skillEvidence.create({
      data: {
        tenantId: tenant.id,
        userId: learnerCtx.userId,
        skillId: skill.id,
        type: "MANUAL",
        sourceType: "Manual",
        sourceId: "unresolvable-source",
      },
    });

    const actorCtx = { ...adminCtx, tenantId: tenant.id };
    await expect(verifyEvidence(actorCtx, evidence.id)).rejects.toThrow(
      CapabilityVerificationError
    );
  });

  it("cross-tenant verification is rejected even for an INSTRUCTOR/SUPER_ADMIN role", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { tenant: otherTenant, ctx: otherAdminCtx } = await createTenantUser("SUPER_ADMIN");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);
    const evidence = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: course.id,
    });

    const actorCtx = { ...otherAdminCtx, tenantId: otherTenant.id };
    await expect(verifyEvidence(actorCtx, evidence.id)).rejects.toThrow(
      CapabilityVerificationError
    );
  });

  it("resolves QUIZ_SCORE evidence back to the owning course via the full Quiz->Lesson->Section->Course traversal", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { lesson } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);
    const quiz = await createQuiz(lesson.id);
    const attempt = await createQuizAttempt(learnerCtx.userId, quiz.id, 90, true);

    const evidence = await db.skillEvidence.create({
      data: {
        tenantId: tenant.id,
        userId: learnerCtx.userId,
        skillId: skill.id,
        type: "QUIZ_SCORE",
        sourceType: "QuizAttempt",
        sourceId: attempt.id,
        score: 90,
      },
    });

    const actorCtx = { ...instructorCtx, tenantId: tenant.id };
    const userSkill = await verifyEvidence(actorCtx, evidence.id);
    expect(userSkill.proficiency).toBe("INTERMEDIATE");
  });

  it("throws a 404 for a nonexistent evidence id", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const actorCtx = { ...instructorCtx, tenantId: tenant.id };
    await expect(verifyEvidence(actorCtx, "does-not-exist")).rejects.toThrow(
      CapabilityVerificationError
    );
  });
});

describe("rejection recompute (Phase 5 architecture challenge, Challenge 6)", () => {
  it("rejecting the only VERIFIED evidence, with an UNVERIFIED row remaining, recomputes to BEGINNER", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);

    const evidenceA = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: course.id,
    });
    const evidenceB = await db.skillEvidence.create({
      data: {
        tenantId: tenant.id,
        userId: learnerCtx.userId,
        skillId: skill.id,
        type: "MANUAL",
        sourceType: "Manual",
        sourceId: "manual-1",
      },
    });

    const actorCtx = { ...instructorCtx, tenantId: tenant.id };
    await verifyEvidence(actorCtx, evidenceA.id);
    let userSkill = await db.userSkill.findUniqueOrThrow({
      where: { userId_skillId: { userId: learnerCtx.userId, skillId: skill.id } },
    });
    expect(userSkill.proficiency).toBe("INTERMEDIATE");

    userSkill = await rejectEvidence(actorCtx, evidenceA.id);
    expect(userSkill.proficiency).toBe("BEGINNER");
    // evidenceB (still UNVERIFIED) remains — never touched by rejecting A.
    const stillThere = await db.skillEvidence.findUniqueOrThrow({ where: { id: evidenceB.id } });
    expect(stillThere.verificationStatus).toBe("UNVERIFIED");
  });

  it("rejecting all remaining evidence recomputes to NONE", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course, lesson } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);
    const quiz = await createQuiz(lesson.id);
    const attempt = await createQuizAttempt(learnerCtx.userId, quiz.id, 90, true);

    const evidenceA = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: course.id,
    });
    // A second, independent evidence source for the same skill — also
    // resolvable back to the same (instructor-owned) course, but via the
    // QuizAttempt traversal rather than a direct Course reference.
    const evidenceB = await db.skillEvidence.create({
      data: {
        tenantId: tenant.id,
        userId: learnerCtx.userId,
        skillId: skill.id,
        type: "QUIZ_SCORE",
        sourceType: "QuizAttempt",
        sourceId: attempt.id,
        score: 90,
      },
    });

    const actorCtx = { ...instructorCtx, tenantId: tenant.id };
    await rejectEvidence(actorCtx, evidenceA.id);
    const userSkill = await rejectEvidence(actorCtx, evidenceB.id);

    expect(userSkill.proficiency).toBe("NONE");
  });

  it("rejecting a VERIFIED row while another independent VERIFIED row supports the same skill preserves INTERMEDIATE", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course, lesson } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);
    const quiz = await createQuiz(lesson.id);
    const attempt = await createQuizAttempt(learnerCtx.userId, quiz.id, 90, true);

    const evidenceA = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: course.id,
    });
    const evidenceB = await db.skillEvidence.create({
      data: {
        tenantId: tenant.id,
        userId: learnerCtx.userId,
        skillId: skill.id,
        type: "QUIZ_SCORE",
        sourceType: "QuizAttempt",
        sourceId: attempt.id,
        score: 90,
      },
    });

    const actorCtx = { ...instructorCtx, tenantId: tenant.id };
    await verifyEvidence(actorCtx, evidenceA.id);
    await verifyEvidence(actorCtx, evidenceB.id);

    const userSkill = await rejectEvidence(actorCtx, evidenceA.id);
    expect(userSkill.proficiency).toBe("INTERMEDIATE");
  });
});

describe("ASSESSMENT evidence (Phase 20 — AssignmentSubmission source resolution)", () => {
  it("resolves ASSESSMENT evidence back to the owning course via AssignmentSubmission->Assignment->Lesson->Section->Course", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { lesson } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);
    const assignment = await createAssignment(lesson.id);
    const submission = await createAssignmentSubmission(learnerCtx.userId, assignment.id);

    const evidence = await db.skillEvidence.create({
      data: {
        tenantId: tenant.id,
        userId: learnerCtx.userId,
        skillId: skill.id,
        type: "ASSESSMENT",
        sourceType: "AssignmentSubmission",
        sourceId: submission.id,
        score: 85,
      },
    });

    const actorCtx = { ...instructorCtx, tenantId: tenant.id };
    const userSkill = await verifyEvidence(actorCtx, evidence.id);
    expect(userSkill.proficiency).toBe("INTERMEDIATE");
  });

  it("an instructor who does not own the assignment's course is rejected", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: otherInstructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { lesson } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);
    const assignment = await createAssignment(lesson.id);
    const submission = await createAssignmentSubmission(learnerCtx.userId, assignment.id);

    const evidence = await db.skillEvidence.create({
      data: {
        tenantId: tenant.id,
        userId: learnerCtx.userId,
        skillId: skill.id,
        type: "ASSESSMENT",
        sourceType: "AssignmentSubmission",
        sourceId: submission.id,
        score: 85,
      },
    });

    const actorCtx = { ...otherInstructorCtx, tenantId: tenant.id };
    await expect(verifyEvidence(actorCtx, evidence.id)).rejects.toThrow(
      CapabilityVerificationError
    );
  });

  it("SUPER_ADMIN can verify ASSESSMENT evidence — the source resolves, so SUPER_ADMIN is not blocked by the previously-missing branch", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: adminCtx } = await createTenantUser("SUPER_ADMIN");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { lesson } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);
    const assignment = await createAssignment(lesson.id);
    const submission = await createAssignmentSubmission(learnerCtx.userId, assignment.id);

    const evidence = await db.skillEvidence.create({
      data: {
        tenantId: tenant.id,
        userId: learnerCtx.userId,
        skillId: skill.id,
        type: "ASSESSMENT",
        sourceType: "AssignmentSubmission",
        sourceId: submission.id,
        score: 85,
      },
    });

    const actorCtx = { ...adminCtx, tenantId: tenant.id };
    const userSkill = await verifyEvidence(actorCtx, evidence.id);
    expect(userSkill.proficiency).toBe("INTERMEDIATE");
  });
});

describe("getReviewableEvidenceForInstructor", () => {
  it("returns null for a non-INSTRUCTOR actor (ORG_ADMIN does not gain verification authority)", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: orgAdminCtx } = await createTenantUser("ORG_ADMIN");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    await createCourse(tenant.id, instructorCtx.userId);

    const actorCtx = { ...orgAdminCtx, tenantId: tenant.id };
    const result = await getReviewableEvidenceForInstructor(actorCtx, learnerCtx.userId);
    expect(result).toBeNull();
  });

  it("returns null when the instructor has no shared enrollment with the student (same as not-found)", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    await createCourse(tenant.id, instructorCtx.userId);
    // learnerCtx is never enrolled in instructorCtx's course.

    const actorCtx = { ...instructorCtx, tenantId: tenant.id };
    const result = await getReviewableEvidenceForInstructor(actorCtx, learnerCtx.userId);
    expect(result).toBeNull();
  });

  it("returns eligible evidence for a student enrolled in the instructor's course", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);
    await db.enrollment.create({
      data: { userId: learnerCtx.userId, courseId: course.id, status: "ACTIVE" },
    });
    const evidence = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: course.id,
    });

    const actorCtx = { ...instructorCtx, tenantId: tenant.id };
    const result = await getReviewableEvidenceForInstructor(actorCtx, learnerCtx.userId);

    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result?.[0]).toMatchObject({
      id: evidence.id,
      skillName: skill.name,
      verificationStatus: "UNVERIFIED",
      courseTitle: course.title,
    });
  });

  it("does not expose evidence from a course the instructor does not own, even for a shared student", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: otherInstructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course: ownCourse } = await createCourse(tenant.id, instructorCtx.userId);
    const { course: otherCourse } = await createCourse(tenant.id, otherInstructorCtx.userId);
    const skill = await createSkill(tenant.id);
    // The student is enrolled with BOTH instructors.
    await db.enrollment.create({
      data: { userId: learnerCtx.userId, courseId: ownCourse.id, status: "ACTIVE" },
    });
    await db.enrollment.create({
      data: { userId: learnerCtx.userId, courseId: otherCourse.id, status: "ACTIVE" },
    });
    // Evidence belongs only to the OTHER instructor's course.
    await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: otherCourse.id,
    });

    const actorCtx = { ...instructorCtx, tenantId: tenant.id };
    const result = await getReviewableEvidenceForInstructor(actorCtx, learnerCtx.userId);

    // Authorized to view the student (shared enrollment via ownCourse), but
    // the one evidence row belongs to a course this instructor does not own.
    expect(result).not.toBeNull();
    expect(result).toHaveLength(0);
  });

  it("does not expose evidence belonging to another tenant", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { tenant: otherTenant } = await createTenantUser("STUDENT");
    const { course } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);
    await db.enrollment.create({
      data: { userId: learnerCtx.userId, courseId: course.id, status: "ACTIVE" },
    });
    // The legitimate row, at the instructor's own tenant.
    const ownTenantEvidence = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: course.id,
    });
    // A row for the same student/course/skill, but stamped with a foreign
    // tenantId — this must never surface, regardless of whether it would
    // otherwise resolve to an owned course. Proves the query's own
    // `tenantId: actor.tenantId` filter, not just the enrollment gate.
    await db.skillEvidence.create({
      data: {
        tenantId: otherTenant.id,
        userId: learnerCtx.userId,
        skillId: skill.id,
        type: "COURSE_COMPLETION",
        sourceType: "Course",
        sourceId: course.id,
      },
    });

    const actorCtx = { ...instructorCtx, tenantId: tenant.id };
    const result = await getReviewableEvidenceForInstructor(actorCtx, learnerCtx.userId);

    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result?.[0].id).toBe(ownTenantEvidence.id);
  });

  it("shows verified and rejected evidence with their correct status", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course } = await createCourse(tenant.id, instructorCtx.userId);
    const skillA = await createSkill(tenant.id);
    const skillB = await createSkill(tenant.id);
    await db.enrollment.create({
      data: { userId: learnerCtx.userId, courseId: course.id, status: "ACTIVE" },
    });
    const evidenceA = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skillA.id,
      courseId: course.id,
    });
    const evidenceB = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skillB.id,
      courseId: course.id,
    });

    const actorCtx = { ...instructorCtx, tenantId: tenant.id };
    await verifyEvidence(actorCtx, evidenceA.id);
    await rejectEvidence(actorCtx, evidenceB.id);

    const result = await getReviewableEvidenceForInstructor(actorCtx, learnerCtx.userId);
    const byId = new Map(result?.map((r) => [r.id, r]));
    expect(byId.get(evidenceA.id)?.verificationStatus).toBe("VERIFIED");
    expect(byId.get(evidenceB.id)?.verificationStatus).toBe("REJECTED");
  });
});

describe("Downstream capability integration — verification composes with the unmodified capability engine", () => {
  it("UNVERIFIED evidence -> unmet gap; verifying it -> UserSkill INTERMEDIATE -> gap met", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { ctx: learnerCtx } = await createTenantUser("STUDENT");
    const { course } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);
    const role = await createJobRole(tenant.id);
    await createRoleSkill(role.id, skill.id, "INTERMEDIATE");
    await createUserJobRole(tenant.id, learnerCtx.userId, role.id);
    await db.enrollment.create({
      data: { userId: learnerCtx.userId, courseId: course.id, status: "ACTIVE" },
    });
    const evidence = await createCourseSourcedEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      skillId: skill.id,
      courseId: course.id,
    });

    const learnerGapCtx = { ...learnerCtx, tenantId: tenant.id };
    const before = await computeCapabilityGap(learnerGapCtx);
    expect(before.gaps).toHaveLength(1);
    expect(before.gaps[0].currentProficiency).toBe("NONE");
    expect(before.gaps[0].met).toBe(false);

    const actorCtx = { ...instructorCtx, tenantId: tenant.id };
    await verifyEvidence(actorCtx, evidence.id);

    const after = await computeCapabilityGap(learnerGapCtx);
    expect(after.gaps[0].currentProficiency).toBe("INTERMEDIATE");
    expect(after.gaps[0].met).toBe(true);
  });
});
