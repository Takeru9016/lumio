import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  createCourse,
  createQuiz,
  createQuizAttempt,
  createSkill,
} from "@/lib/domain/capability/__test__/fixtures";
import {
  CapabilityVerificationError,
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
