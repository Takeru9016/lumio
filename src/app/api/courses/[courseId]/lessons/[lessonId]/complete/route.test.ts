import { auth } from "@clerk/nextjs/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  createCourse,
  createSkill,
  mapCourseSkill,
} from "@/lib/domain/capability/__test__/fixtures";
import {
  addLesson,
  createSoloUser,
  createUserInTenant,
} from "@/lib/domain/course/__test__/fixtures";
import { createTenantUser } from "@/lib/domain/knowledge/__test__/fixtures";
import { recordMandatoryTrainingCompletion } from "@/lib/mandatory-training";
import { awardXP } from "@/lib/xp";
import { POST } from "./route";

const { uploadFiles, sendEmail } = vi.hoisted(() => ({ uploadFiles: vi.fn(), sendEmail: vi.fn() }));

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));
// External boundaries only: the certificate generator itself, XP, streaks and
// the database all run for real.
vi.mock("uploadthing/server", () => ({
  UTApi: class {
    uploadFiles = uploadFiles;
  },
}));
vi.mock("@/lib/resend", () => ({ resend: { emails: { send: sendEmail } } }));
vi.mock("@/lib/xp", async () => {
  const actual = await vi.importActual<typeof import("@/lib/xp")>("@/lib/xp");
  return { ...actual, awardXP: vi.fn() };
});
vi.mock("@/lib/mandatory-training", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mandatory-training")>(
    "@/lib/mandatory-training"
  );
  return { ...actual, recordMandatoryTrainingCompletion: vi.fn() };
});

const realXp = await vi.importActual<typeof import("@/lib/xp")>("@/lib/xp");
const realTraining = await vi.importActual<typeof import("@/lib/mandatory-training")>(
  "@/lib/mandatory-training"
);

beforeEach(() => {
  vi.mocked(awardXP).mockImplementation(realXp.awardXP);
  vi.mocked(recordMandatoryTrainingCompletion).mockImplementation(
    realTraining.recordMandatoryTrainingCompletion
  );
  uploadFiles.mockResolvedValue({ data: { ufsUrl: "https://utfs.io/f/test-cert" }, error: null });
  sendEmail.mockResolvedValue({ data: { id: "email" }, error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(auth).mockReset();
  uploadFiles.mockReset();
  sendEmail.mockReset();
});

afterAll(async () => {
  await db.$disconnect();
});

const complete = (courseSlug: string, lessonId: string) =>
  POST(new Request("http://localhost/x", { method: "POST" }), {
    params: Promise.resolve({ courseId: courseSlug, lessonId }),
  });

/** A tenant course with one lesson, `skillCount` mapped skills, and an ACTIVE learner. */
async function setup(skillCount = 1) {
  const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
  const { course, section, lesson } = await createCourse(tenant.id, instructorCtx.userId);
  const learner = await createUserInTenant(tenant.id, "STUDENT");
  const skills = [];
  for (let i = 0; i < skillCount; i += 1) {
    const skill = await createSkill(tenant.id);
    await mapCourseSkill(course.id, skill.id);
    skills.push(skill);
  }
  const enrollment = await db.enrollment.create({
    data: { userId: learner.id, courseId: course.id },
  });
  vi.mocked(auth).mockResolvedValue({ userId: learner.clerkId } as never);
  return { tenant, course, section, lesson, learner, skills, enrollment };
}

const evidenceCount = (userId: string) => db.skillEvidence.count({ where: { userId } });
const courseXp = (userId: string) =>
  db.xPTransaction.count({ where: { userId, event: "COURSE_COMPLETE" } });

describe("POST …/lessons/[lessonId]/complete — capability evidence durability", () => {
  it("a normal completion records evidence alongside XP, certificate and the completion event", async () => {
    const { course, lesson, learner } = await setup(2);

    const res = await complete(course.slug, lesson.id);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ courseCompleted: true, courseXpEarned: 100 });
    expect((await db.enrollment.findFirst({ where: { userId: learner.id } }))?.status).toBe(
      "COMPLETED"
    );
    expect(await evidenceCount(learner.id)).toBe(2);
    expect(await courseXp(learner.id)).toBe(1);
    expect(await db.certificate.count({ where: { userId: learner.id } })).toBe(1);
    expect(
      await db.learningEvent.count({ where: { userId: learner.id, eventType: "COURSE_COMPLETED" } })
    ).toBe(1);
  });

  it("an XP failure does not prevent the evidence", async () => {
    const { course, lesson, learner } = await setup();
    vi.mocked(awardXP).mockImplementation(async (userId, event, amount) => {
      if (event === "COURSE_COMPLETE") throw new Error("xp unavailable");
      return realXp.awardXP(userId, event, amount);
    });

    await expect(complete(course.slug, lesson.id)).rejects.toThrow("xp unavailable");

    expect(await evidenceCount(learner.id)).toBe(1);
    expect((await db.enrollment.findFirst({ where: { userId: learner.id } }))?.status).toBe(
      "COMPLETED"
    );
  });

  it("a certificate upload failure does not prevent the evidence", async () => {
    const { course, lesson, learner } = await setup();
    uploadFiles.mockRejectedValue(new Error("upload unavailable"));

    await expect(complete(course.slug, lesson.id)).rejects.toThrow("upload unavailable");

    expect(await evidenceCount(learner.id)).toBe(1);
    expect(await db.certificate.count({ where: { userId: learner.id } })).toBe(0);
  });

  it("a certificate upload that reports an error result (no throw) does not prevent the evidence either", async () => {
    const { course, lesson, learner } = await setup();
    uploadFiles.mockResolvedValue({ data: null, error: { message: "rejected" } });

    const res = await complete(course.slug, lesson.id);

    expect(res.status).toBe(200);
    expect(await evidenceCount(learner.id)).toBe(1);
  });

  it("an email failure does not prevent the evidence", async () => {
    const { course, lesson, learner } = await setup();
    sendEmail.mockRejectedValue(new Error("email unavailable"));

    await expect(complete(course.slug, lesson.id)).rejects.toThrow("email unavailable");

    expect(await evidenceCount(learner.id)).toBe(1);
  });

  it("a mandatory-training failure does not prevent the evidence", async () => {
    const { course, lesson, learner } = await setup();
    vi.mocked(recordMandatoryTrainingCompletion).mockRejectedValue(new Error("training down"));

    await expect(complete(course.slug, lesson.id)).rejects.toThrow("training down");

    expect(await evidenceCount(learner.id)).toBe(1);
  });

  it("retrying after a side-effect failure is safe: evidence and XP stay exactly-once and the certificate is completed", async () => {
    const { course, lesson, learner } = await setup();
    uploadFiles.mockRejectedValueOnce(new Error("upload unavailable"));

    await expect(complete(course.slug, lesson.id)).rejects.toThrow("upload unavailable");
    expect(await db.certificate.count({ where: { userId: learner.id } })).toBe(0);

    const retry = await complete(course.slug, lesson.id);

    expect(retry.status).toBe(200);
    expect(await evidenceCount(learner.id)).toBe(1);
    expect(await courseXp(learner.id)).toBe(1);
    expect(await db.certificate.count({ where: { userId: learner.id } })).toBe(1);
    expect(
      await db.learningEvent.count({ where: { userId: learner.id, eventType: "COURSE_COMPLETED" } })
    ).toBe(1);
  });

  it("an evidence failure is not swallowed, does not block the other side effects, and a retry reconciles it", async () => {
    const { course, lesson, learner, skills } = await setup();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(db, "$transaction").mockRejectedValueOnce(new Error("transient database failure"));

    await expect(complete(course.slug, lesson.id)).rejects.toThrow(/course-completion evidence/i);
    vi.restoreAllMocks();

    expect(errorLog).toHaveBeenCalled();
    expect(await evidenceCount(learner.id)).toBe(0);
    // The failed evidence did not stop the unrelated completion side effects.
    expect(await courseXp(learner.id)).toBe(1);
    expect(await db.certificate.count({ where: { userId: learner.id } })).toBe(1);

    uploadFiles.mockResolvedValue({ data: { ufsUrl: "https://utfs.io/f/test-cert" }, error: null });
    sendEmail.mockResolvedValue({ data: { id: "email" }, error: null });
    const retry = await complete(course.slug, lesson.id);

    expect(retry.status).toBe(200);
    const rows = await db.skillEvidence.findMany({ where: { userId: learner.id } });
    expect(rows.map((r) => r.skillId)).toEqual([skills[0].id]);
    expect(await courseXp(learner.id)).toBe(1);
  });

  it("repeated completion requests never duplicate evidence, XP or the certificate", async () => {
    const { course, lesson, learner } = await setup(2);

    await complete(course.slug, lesson.id);
    await complete(course.slug, lesson.id);
    await complete(course.slug, lesson.id);

    expect(await evidenceCount(learner.id)).toBe(2);
    expect(await courseXp(learner.id)).toBe(1);
    expect(await db.certificate.count({ where: { userId: learner.id } })).toBe(1);
  });

  it("concurrent completion requests produce exactly one evidence row per skill", async () => {
    const { course, lesson, learner } = await setup(2);
    // Certificate creation has its own pre-existing race between the winning and
    // losing request; a silent upload result keeps this test about evidence.
    uploadFiles.mockResolvedValue({ data: null, error: { message: "skipped" } });

    await Promise.all([complete(course.slug, lesson.id), complete(course.slug, lesson.id)]);

    expect(await evidenceCount(learner.id)).toBe(2);
    expect(await courseXp(learner.id)).toBe(1);
  });
});

describe("POST …/lessons/[lessonId]/complete — recovery of already-completed enrollments", () => {
  it("a request on a COMPLETED enrollment whose evidence was lost reconciles it", async () => {
    const { course, lesson, learner, enrollment } = await setup();
    await db.enrollment.update({
      where: { id: enrollment.id },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    await db.lessonProgress.create({
      data: { userId: learner.id, lessonId: lesson.id, isCompleted: true, completedAt: new Date() },
    });
    expect(await evidenceCount(learner.id)).toBe(0);

    const res = await complete(course.slug, lesson.id);

    expect(res.status).toBe(200);
    expect(await evidenceCount(learner.id)).toBe(1);
  });

  it("a COMPLETED enrollment whose course later gained a lesson still reconciles its evidence", async () => {
    const { course, section, lesson, learner, enrollment } = await setup();
    await db.enrollment.update({
      where: { id: enrollment.id },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    await addLesson(section.id, 9);
    expect(await evidenceCount(learner.id)).toBe(0);

    const res = await complete(course.slug, lesson.id);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ courseCompleted: false });
    expect(await evidenceCount(learner.id)).toBe(1);
  });

  it("finishing only some lessons creates no evidence and does not complete the enrollment", async () => {
    const { course, section, lesson, learner } = await setup();
    await addLesson(section.id, 9);

    const res = await complete(course.slug, lesson.id);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ courseCompleted: false });
    expect(await evidenceCount(learner.id)).toBe(0);
    expect((await db.enrollment.findFirst({ where: { userId: learner.id } }))?.status).toBe(
      "ACTIVE"
    );
  });

  it("a learner with no tenant (solo/FREE plan) completes normally and receives no capability evidence", async () => {
    const soloLearner = await createSoloUser("STUDENT");
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { course, lesson } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);
    await mapCourseSkill(course.id, skill.id);
    await db.enrollment.create({ data: { userId: soloLearner.id, courseId: course.id } });
    vi.mocked(auth).mockResolvedValue({ userId: soloLearner.clerkId } as never);

    const res = await complete(course.slug, lesson.id);

    expect(res.status).toBe(200);
    expect(await evidenceCount(soloLearner.id)).toBe(0);
  });

  it("a learner from another tenant completing the course receives no evidence", async () => {
    const { tenant, ctx: instructorCtx } = await createTenantUser("INSTRUCTOR");
    const { course, lesson } = await createCourse(tenant.id, instructorCtx.userId);
    const skill = await createSkill(tenant.id);
    await mapCourseSkill(course.id, skill.id);
    const { user: outsider } = await createTenantUser("STUDENT");
    await db.enrollment.create({ data: { userId: outsider.id, courseId: course.id } });
    vi.mocked(auth).mockResolvedValue({ userId: outsider.clerkId } as never);

    const res = await complete(course.slug, lesson.id);

    expect(res.status).toBe(200);
    expect(await evidenceCount(outsider.id)).toBe(0);
  });
});
