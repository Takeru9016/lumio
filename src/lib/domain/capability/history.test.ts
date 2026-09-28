import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { Role } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import {
  createCourse,
  createQuiz,
  createQuizAttempt,
  createSkill,
  mapCourseSkill,
} from "@/lib/domain/capability/__test__/fixtures";
import { backfillTenant } from "@/lib/domain/capability/capabilityBackfill";
import {
  determineOrderingMode,
  getInstructorLearnerHistory,
  getLearnerHistory,
  getOrgLearnerHistory,
  HistoryCursorError,
} from "@/lib/domain/capability/history";
import { recordCourseCompletionEvidence } from "@/lib/domain/capability/outcomes";
import {
  reinstateEvidence,
  revokeEvidence,
  verifyEvidence,
} from "@/lib/domain/capability/verification";
import { createTenantUser } from "@/lib/domain/knowledge/__test__/fixtures";

/**
 * Phase 30.4 — domain-level tests for the capability history read surface
 * (docs/PHASE_30.4_DISCOVERY.md). Runs against the real database, mirroring
 * this repo's own convention for capability-domain tests (proficiency.test.ts,
 * verification.transitions.test.ts, capabilityBackfill.test.ts) — a mocked
 * domain layer cannot prove no data leaked, only that a typed shape was
 * returned.
 */

afterAll(async () => {
  await db.$disconnect();
});

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

async function createUserInTenant(tenantId: string, role: Role) {
  const user = await db.user.create({
    data: { clerkId: unique("clerk"), email: `${unique("user")}@example.test`, tenantId, role },
  });
  return { user, ctx: { userId: user.id, clerkId: user.clerkId, tenantId, role: user.role } };
}

async function enroll(userId: string, courseId: string) {
  return db.enrollment.create({
    data: { userId, courseId, status: "COMPLETED", completedAt: new Date() },
  });
}

/**
 * Two instructors, one org admin, one learner, all in one tenant. The
 * learner completes both instructors' courses (mapped to the same skill),
 * so instructor1's authorized-evidence scope must exclude instructor2's
 * evidence even though both target the same learner and skill.
 */
async function setupScenario() {
  const { tenant, ctx: instructor1 } = await createTenantUser("INSTRUCTOR");
  const { ctx: instructor2 } = await createUserInTenant(tenant.id, "INSTRUCTOR");
  const { ctx: orgAdmin } = await createUserInTenant(tenant.id, "ORG_ADMIN");
  const { user: learner, ctx: learnerCtx } = await createUserInTenant(tenant.id, "STUDENT");

  const skill = await createSkill(tenant.id);
  const { course: course1 } = await createCourse(tenant.id, instructor1.userId);
  const { course: course2 } = await createCourse(tenant.id, instructor2.userId);
  await mapCourseSkill(course1.id, skill.id);
  await mapCourseSkill(course2.id, skill.id);

  await enroll(learner.id, course1.id);
  await enroll(learner.id, course2.id);

  await recordCourseCompletionEvidence({
    tenantId: tenant.id,
    userId: learner.id,
    courseId: course1.id,
    occurredAt: new Date(),
  });
  await recordCourseCompletionEvidence({
    tenantId: tenant.id,
    userId: learner.id,
    courseId: course2.id,
    occurredAt: new Date(),
  });

  const evidence1 = await db.skillEvidence.findFirstOrThrow({
    where: { userId: learner.id, sourceId: course1.id },
  });
  const evidence2 = await db.skillEvidence.findFirstOrThrow({
    where: { userId: learner.id, sourceId: course2.id },
  });

  await verifyEvidence(instructor1, evidence1.id);
  await verifyEvidence(instructor2, evidence2.id);

  return {
    tenant,
    instructor1,
    instructor2,
    orgAdmin,
    learner,
    learnerCtx,
    skill,
    course1,
    course2,
    evidence1,
    evidence2,
  };
}

// ---------------------------------------------------------------------------
// Ordering mode — pure function, no database
// ---------------------------------------------------------------------------

describe("determineOrderingMode", () => {
  it("no filters -> recorded mode, both tables", () => {
    expect(determineOrderingMode({})).toEqual({
      mode: "recorded",
      tables: ["PROFICIENCY_CHANGED", "EVIDENCE_STANDING_CHANGED"],
    });
  });

  it("type=PROFICIENCY_CHANGED + skillId -> seq mode", () => {
    expect(determineOrderingMode({ type: "PROFICIENCY_CHANGED", skillId: "s1" })).toEqual({
      mode: "seq",
      tables: ["PROFICIENCY_CHANGED"],
    });
  });

  it("type=PROFICIENCY_CHANGED without skillId -> recorded mode, single table", () => {
    expect(determineOrderingMode({ type: "PROFICIENCY_CHANGED" })).toEqual({
      mode: "recorded",
      tables: ["PROFICIENCY_CHANGED"],
    });
  });

  it("type=EVIDENCE_STANDING_CHANGED + evidenceId -> revision mode", () => {
    expect(determineOrderingMode({ type: "EVIDENCE_STANDING_CHANGED", evidenceId: "e1" })).toEqual({
      mode: "revision",
      tables: ["EVIDENCE_STANDING_CHANGED"],
    });
  });

  it("type=EVIDENCE_STANDING_CHANGED without evidenceId -> recorded mode, single table", () => {
    expect(determineOrderingMode({ type: "EVIDENCE_STANDING_CHANGED" })).toEqual({
      mode: "recorded",
      tables: ["EVIDENCE_STANDING_CHANGED"],
    });
  });

  it("evidenceId alone (no type narrowing) -> recorded mode, both tables", () => {
    expect(determineOrderingMode({ evidenceId: "e1" })).toEqual({
      mode: "recorded",
      tables: ["PROFICIENCY_CHANGED", "EVIDENCE_STANDING_CHANGED"],
    });
  });
});

// ---------------------------------------------------------------------------
// Learner scope
// ---------------------------------------------------------------------------

describe("getLearnerHistory", () => {
  it("returns both event types, typed and discriminated", async () => {
    const { learnerCtx, evidence1 } = await setupScenario();

    const page = await getLearnerHistory(learnerCtx, {});

    expect(page.items.length).toBeGreaterThan(0);
    const types = new Set(page.items.map((i) => i.type));
    expect(types.has("PROFICIENCY_CHANGED")).toBe(true);
    expect(types.has("EVIDENCE_STANDING_CHANGED")).toBe(true);
    const standing = page.items.find(
      (i): i is Extract<typeof i, { type: "EVIDENCE_STANDING_CHANGED" }> =>
        i.type === "EVIDENCE_STANDING_CHANGED" && i.evidenceId === evidence1.id
    );
    expect(standing?.action).toBe("VERIFY");
  });

  it("is self-scoped structurally — no userId parameter exists to forge", async () => {
    const { learnerCtx } = await setupScenario();
    // getLearnerHistory's own type signature has no userId/tenantId override
    // parameter; ctx.userId/ctx.tenantId are the only source. This test
    // documents that guarantee by construction rather than by a runtime check
    // that has nothing to assert against.
    const page = await getLearnerHistory(learnerCtx, {});
    for (const item of page.items) {
      if (item.type === "EVIDENCE_STANDING_CHANGED") {
        const row = await db.evidenceStandingEvent.findUniqueOrThrow({
          where: {
            id: (await db.evidenceStandingEvent.findFirst({
              where: { evidenceId: item.evidenceId },
            }))!.id,
          },
        });
        expect(row.userId).toBe(learnerCtx.userId);
        expect(row.tenantId).toBe(learnerCtx.tenantId);
      }
    }
  });

  it("learner never sees actorName on evidence-standing items", async () => {
    const { learnerCtx } = await setupScenario();
    const page = await getLearnerHistory(learnerCtx, {});
    for (const item of page.items) {
      if (item.type === "EVIDENCE_STANDING_CHANGED") {
        expect("actorName" in item).toBe(false);
      }
    }
  });

  it("filters by skillId, excluding a DIFFERENT skill that has its own real events for the same learner", async () => {
    const { tenant, learnerCtx, skill, instructor1 } = await setupScenario();
    // A second skill with its own real, verified evidence for this exact
    // learner — not an empty skill with nothing to leak. Removing the
    // skillId filter from either underlying query must be observable here.
    const otherSkill = await createSkill(tenant.id);
    const { course: otherCourse } = await createCourse(tenant.id, instructor1.userId);
    await mapCourseSkill(otherCourse.id, otherSkill.id);
    await db.enrollment.create({
      data: {
        userId: learnerCtx.userId,
        courseId: otherCourse.id,
        status: "COMPLETED",
        completedAt: new Date(),
      },
    });
    await recordCourseCompletionEvidence({
      tenantId: tenant.id,
      userId: learnerCtx.userId,
      courseId: otherCourse.id,
      occurredAt: new Date(),
    });
    const otherEvidence = await db.skillEvidence.findFirstOrThrow({
      where: { userId: learnerCtx.userId, sourceId: otherCourse.id },
    });
    await verifyEvidence(instructor1, otherEvidence.id);

    const page = await getLearnerHistory(learnerCtx, { skillId: skill.id });
    expect(page.items.length).toBeGreaterThan(0);
    for (const item of page.items) expect(item.skillId).toBe(skill.id);
    expect(page.items.some((i) => i.skillId === otherSkill.id)).toBe(false);
  });

  it("filters by type", async () => {
    const { learnerCtx } = await setupScenario();
    const page = await getLearnerHistory(learnerCtx, { type: "EVIDENCE_STANDING_CHANGED" });
    expect(page.items.length).toBeGreaterThan(0);
    for (const item of page.items) expect(item.type).toBe("EVIDENCE_STANDING_CHANGED");
  });

  it("filters by date range [from, to)", async () => {
    const { learnerCtx } = await setupScenario();
    const future = new Date(Date.now() + 60_000);
    const page = await getLearnerHistory(learnerCtx, { from: future });
    expect(page.items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Instructor scope — authorization
// ---------------------------------------------------------------------------

describe("getInstructorLearnerHistory — authorization", () => {
  it("authorized instructor sees only their own course's evidence", async () => {
    const { instructor1, learner, evidence1, evidence2 } = await setupScenario();

    const page = await getInstructorLearnerHistory(instructor1, learner.id, {});
    expect(page).not.toBeNull();
    const evidenceIds = new Set(
      page!.items.filter((i) => i.type === "EVIDENCE_STANDING_CHANGED").map((i) => i.evidenceId)
    );
    expect(evidenceIds.has(evidence1.id)).toBe(true);
    expect(evidenceIds.has(evidence2.id)).toBe(false);
  });

  it("unrelated learner (no shared enrollment) -> null", async () => {
    const { tenant, instructor1 } = await setupScenario();
    const { user: otherLearner } = await createUserInTenant(tenant.id, "STUDENT");
    const page = await getInstructorLearnerHistory(instructor1, otherLearner.id, {});
    expect(page).toBeNull();
  });

  it("foreign-tenant learner -> null, not a distinguishable result", async () => {
    const { instructor1 } = await setupScenario();
    const { user: foreignLearner } = await createTenantUser("STUDENT");
    const page = await getInstructorLearnerHistory(instructor1, foreignLearner.id, {});
    expect(page).toBeNull();
  });

  it("soft-deleted learner the instructor previously shared an enrollment with -> null, not a partial result", async () => {
    const { instructor1, learner } = await setupScenario();
    await db.user.update({ where: { id: learner.id }, data: { deletedAt: new Date() } });
    const page = await getInstructorLearnerHistory(instructor1, learner.id, {});
    expect(page).toBeNull();
  });

  it("legacy QuizAttempt-sourced evidence still resolves for the owning instructor", async () => {
    const { tenant, ctx: instructor1 } = await createTenantUser("INSTRUCTOR");
    const { user: learner, ctx: learnerCtx } = await createUserInTenant(tenant.id, "STUDENT");
    const skill = await createSkill(tenant.id);
    const { course, lesson } = await createCourse(tenant.id, instructor1.userId);
    await mapCourseSkill(course.id, skill.id);
    await enroll(learner.id, course.id);
    const quiz = await createQuiz(lesson.id);
    const attempt = await createQuizAttempt(learner.id, quiz.id, 90, true);

    const evidence = await db.skillEvidence.create({
      data: {
        tenantId: tenant.id,
        userId: learner.id,
        skillId: skill.id,
        type: "QUIZ_SCORE",
        sourceType: "QuizAttempt",
        sourceId: attempt.id,
        score: 90,
      },
    });
    await verifyEvidence(instructor1, evidence.id);

    const page = await getInstructorLearnerHistory(instructor1, learner.id, {});
    expect(page).not.toBeNull();
    const item = page!.items.find(
      (i) => i.type === "EVIDENCE_STANDING_CHANGED" && i.evidenceId === evidence.id
    );
    expect(item).toBeDefined();
    if (item?.type === "EVIDENCE_STANDING_CHANGED") {
      expect(item.sourceContext.courseTitle).toBe(course.title);
    }
    void learnerCtx;
  });

  it("evidence with an unresolvable source (deleted lesson) is fail-closed out of the instructor's view (discovery §7)", async () => {
    const { tenant, ctx: instructor1 } = await createTenantUser("INSTRUCTOR");
    const { user: learner } = await createUserInTenant(tenant.id, "STUDENT");
    const skill = await createSkill(tenant.id);
    const { course, lesson } = await createCourse(tenant.id, instructor1.userId);
    await mapCourseSkill(course.id, skill.id);
    await enroll(learner.id, course.id);
    const quiz = await createQuiz(lesson.id);

    const evidence = await db.skillEvidence.create({
      data: {
        tenantId: tenant.id,
        userId: learner.id,
        skillId: skill.id,
        type: "QUIZ_SCORE",
        sourceType: "Quiz",
        sourceId: quiz.id,
        score: 90,
      },
    });
    await verifyEvidence(instructor1, evidence.id);
    // Simulate the live lesson-delete cascade (30.3 discovery §1/§16): the
    // quiz disappears, orphaning the evidence's sourceId.
    await db.quiz.delete({ where: { id: quiz.id } });

    const page = await getInstructorLearnerHistory(instructor1, learner.id, {});
    expect(page).not.toBeNull();
    expect(
      page!.items.some(
        (i) => i.type === "EVIDENCE_STANDING_CHANGED" && i.evidenceId === evidence.id
      )
    ).toBe(false);
  });

  it("BASELINE/RECALCULATED proficiency events (null evidenceId) never appear in the instructor's view", async () => {
    const { instructor1, learner, skill, tenant } = await setupScenario();
    // Force a BASELINE row via a second, directly-created UserSkill the real
    // backfill has not touched (eventSeq 0 by default).
    const secondSkill = await createSkill(tenant.id);
    await db.userSkill.create({
      data: {
        tenantId: tenant.id,
        userId: learner.id,
        skillId: secondSkill.id,
        proficiency: "BEGINNER",
      },
    });
    await backfillTenant(tenant.id);

    const page = await getInstructorLearnerHistory(instructor1, learner.id, {});
    expect(page).not.toBeNull();
    expect(
      page!.items.some((i) => i.type === "PROFICIENCY_CHANGED" && i.cause === "BASELINE")
    ).toBe(false);
    void skill;
  });
});

// ---------------------------------------------------------------------------
// Instructor scope — pagination correctness (discovery §7/§14 regression)
// ---------------------------------------------------------------------------

describe("getInstructorLearnerHistory — pagination stays correctly sized under authorization filtering", () => {
  it("a small page returns full, authorized-only pages even when the newest events are unauthorized", async () => {
    const { tenant, ctx: instructor1 } = await createTenantUser("INSTRUCTOR");
    const { ctx: instructor2 } = await createUserInTenant(tenant.id, "INSTRUCTOR");
    const { user: learner } = await createUserInTenant(tenant.id, "STUDENT");
    const skill = await createSkill(tenant.id);
    const { course: ownCourse } = await createCourse(tenant.id, instructor1.userId);
    const { course: otherCourse } = await createCourse(tenant.id, instructor2.userId);
    await mapCourseSkill(ownCourse.id, skill.id);
    await mapCourseSkill(otherCourse.id, skill.id);
    await enroll(learner.id, ownCourse.id);
    await enroll(learner.id, otherCourse.id);

    // Three authorized (own-course) evidence rows, verified first (older).
    const ownEvidenceIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const lesson = await db.lesson.create({
        data: {
          title: unique("lesson"),
          slug: unique("lesson-slug"),
          type: "TEXT",
          order: i,
          isPublished: true,
          sectionId: (await db.section.findFirstOrThrow({ where: { courseId: ownCourse.id } })).id,
        },
      });
      const quiz = await createQuiz(lesson.id);
      const evidence = await db.skillEvidence.create({
        data: {
          tenantId: tenant.id,
          userId: learner.id,
          skillId: skill.id,
          type: "QUIZ_SCORE",
          sourceType: "Quiz",
          sourceId: quiz.id,
          score: 90,
        },
      });
      await verifyEvidence(instructor1, evidence.id);
      ownEvidenceIds.push(evidence.id);
    }

    // Five UNAUTHORIZED (other-instructor-course) evidence rows, verified
    // after — these have the newest recordedAt/EvidenceStandingEvent rows,
    // so a naive "fetch newest page, filter after" implementation would
    // return an empty or short page for a small `limit`.
    for (let i = 0; i < 5; i++) {
      const lesson = await db.lesson.create({
        data: {
          title: unique("lesson"),
          slug: unique("lesson-slug"),
          type: "TEXT",
          order: i,
          isPublished: true,
          sectionId: (await db.section.findFirstOrThrow({ where: { courseId: otherCourse.id } }))
            .id,
        },
      });
      const quiz = await createQuiz(lesson.id);
      const evidence = await db.skillEvidence.create({
        data: {
          tenantId: tenant.id,
          userId: learner.id,
          skillId: skill.id,
          type: "QUIZ_SCORE",
          sourceType: "Quiz",
          sourceId: quiz.id,
          score: 90,
        },
      });
      await verifyEvidence(instructor2, evidence.id);
    }

    const page = await getInstructorLearnerHistory(
      instructor1,
      learner.id,
      { type: "EVIDENCE_STANDING_CHANGED" },
      { limit: 2 }
    );
    expect(page).not.toBeNull();
    expect(page!.items).toHaveLength(2);
    for (const item of page!.items) {
      expect(item.type).toBe("EVIDENCE_STANDING_CHANGED");
      if (item.type === "EVIDENCE_STANDING_CHANGED") {
        expect(ownEvidenceIds.includes(item.evidenceId)).toBe(true);
      }
    }
    expect(page!.nextCursor).not.toBeNull();

    const page2 = await getInstructorLearnerHistory(
      instructor1,
      learner.id,
      { type: "EVIDENCE_STANDING_CHANGED" },
      { limit: 2, cursor: page!.nextCursor! }
    );
    expect(page2!.items).toHaveLength(1);
    expect(page2!.nextCursor).toBeNull();

    const allSeen = [...page!.items, ...page2!.items].map((i) =>
      i.type === "EVIDENCE_STANDING_CHANGED" ? i.evidenceId : null
    );
    expect(new Set(allSeen)).toEqual(new Set(ownEvidenceIds));
  });
});

// ---------------------------------------------------------------------------
// ORG_ADMIN scope
// ---------------------------------------------------------------------------

describe("getOrgLearnerHistory", () => {
  it("sees history for any learner in the tenant, no course-ownership narrowing", async () => {
    const { orgAdmin, learner, evidence1, evidence2 } = await setupScenario();
    const page = await getOrgLearnerHistory(orgAdmin, learner.id, {});
    expect(page).not.toBeNull();
    const evidenceIds = new Set(
      page!.items.filter((i) => i.type === "EVIDENCE_STANDING_CHANGED").map((i) => i.evidenceId)
    );
    expect(evidenceIds.has(evidence1.id)).toBe(true);
    expect(evidenceIds.has(evidence2.id)).toBe(true);
  });

  it("foreign-tenant learner -> null", async () => {
    const { orgAdmin } = await setupScenario();
    const { user: foreignLearner } = await createTenantUser("STUDENT");
    const page = await getOrgLearnerHistory(orgAdmin, foreignLearner.id, {});
    expect(page).toBeNull();
  });

  it("soft-deleted learner -> null, matching contract E6 and the instructor scope's own rule", async () => {
    const { orgAdmin, learner } = await setupScenario();
    await db.user.update({ where: { id: learner.id }, data: { deletedAt: new Date() } });
    const page = await getOrgLearnerHistory(orgAdmin, learner.id, {});
    expect(page).toBeNull();
  });

  it("instructor/org views include actorName; learner view does not", async () => {
    const { orgAdmin, learner } = await setupScenario();
    const page = await getOrgLearnerHistory(orgAdmin, learner.id, {});
    const standing = page!.items.find((i) => i.type === "EVIDENCE_STANDING_CHANGED");
    expect(standing).toBeDefined();
    if (standing?.type === "EVIDENCE_STANDING_CHANGED") {
      expect("actorName" in standing).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Ordering and pagination — the combined (recordedAt, id) feed
// ---------------------------------------------------------------------------

describe("combined feed ordering and pagination", () => {
  it("returns newest first, stable across pages, no duplicate or skipped item", async () => {
    const { learnerCtx } = await setupScenario();

    const page1 = await getLearnerHistory(learnerCtx, {}, { limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await getLearnerHistory(learnerCtx, {}, { limit: 1, cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(1);

    const key = (i: (typeof page1.items)[number]) =>
      i.type === "PROFICIENCY_CHANGED"
        ? `p:${i.skillId}:${i.occurredAt.toISOString()}`
        : `s:${i.evidenceId}:${i.action}`;
    expect(key(page1.items[0])).not.toBe(key(page2.items[0]));
  });

  it("a page that straddles BOTH source tables merges correctly, in true recordedAt order, at a real tie boundary", async () => {
    // One row from each table sharing the EXACT same recordedAt (the merge
    // boundary this test exists for — JS compareDesc and Postgres's own
    // (recordedAt, id) keyset predicate must agree on tie-break order, since
    // one page's cursor is handed to the other table's query on the next
    // fetch), plus a distinctly older third row. lumio_test's collation is
    // en_US.UTF-8 (confirmed via `SELECT datcollate FROM pg_database`); cuid
    // ids are lowercase ASCII [0-9a-z] only, a charset for which en_US.UTF-8
    // and JS's UTF-16-code-unit `<`/`>` comparison order identically (no
    // accented/special characters exist in this alphabet to diverge on) —
    // stated here, not assumed, since the whole point of this test is not
    // to trust that claim without exercising the real boundary it protects.
    const { tenant, learnerCtx } = await setupScenario();
    const tied = new Date();
    const older = new Date(tied.getTime() - 60_000);

    const skillX = await createSkill(tenant.id);
    const evX = await db.skillEvidence.create({
      data: {
        tenantId: tenant.id,
        userId: learnerCtx.userId,
        skillId: skillX.id,
        type: "MANUAL",
        sourceType: "Manual",
        sourceId: null,
      },
    });
    const proficiencyRow = await db.skillProficiencyEvent.create({
      data: {
        tenantId: tenant.id,
        userId: learnerCtx.userId,
        skillId: skillX.id,
        seq: 1,
        cause: "EVIDENCE_ADDED",
        newProficiency: "BEGINNER",
        policyVersion: 1,
        occurredAt: tied,
        recordedAt: tied,
      },
    });
    const standingRow = await db.evidenceStandingEvent.create({
      data: {
        tenantId: tenant.id,
        userId: learnerCtx.userId,
        skillId: skillX.id,
        evidenceId: evX.id,
        evidenceRevision: 1,
        action: "VERIFY",
        previousVerificationStatus: "UNVERIFIED",
        newVerificationStatus: "VERIFIED",
        previousState: "ACTIVE",
        newState: "ACTIVE",
        occurredAt: tied,
        recordedAt: tied,
      },
    });
    const olderRow = await db.skillProficiencyEvent.create({
      data: {
        tenantId: tenant.id,
        userId: learnerCtx.userId,
        skillId: skillX.id,
        seq: 2,
        cause: "EVIDENCE_VERIFIED",
        newProficiency: "INTERMEDIATE",
        policyVersion: 1,
        occurredAt: older,
        recordedAt: older,
      },
    });

    // Ground truth: the same comparator this module's own compareDesc uses.
    const [expectedFirst, expectedSecond] =
      proficiencyRow.id > standingRow.id
        ? [
            { kind: "p", id: proficiencyRow.id },
            { kind: "s", id: standingRow.id },
          ]
        : [
            { kind: "s", id: standingRow.id },
            { kind: "p", id: proficiencyRow.id },
          ];

    const seen: { kind: "p" | "s"; recordedAt: number }[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 3; i++) {
      const page = await getLearnerHistory(
        learnerCtx,
        { skillId: skillX.id },
        { limit: 1, cursor }
      );
      expect(page.items).toHaveLength(1);
      const item = page.items[0];
      if (item.type === "PROFICIENCY_CHANGED") {
        seen.push({ kind: "p", recordedAt: item.recordedAt.getTime() });
      } else {
        seen.push({ kind: "s", recordedAt: item.occurredAt.getTime() });
      }
      cursor = page.nextCursor ?? undefined;
    }
    expect(cursor).toBeUndefined();

    // Exactly one row of each shape at the tied timestamp, one older
    // PROFICIENCY_CHANGED row — three rows seen exactly once, in true
    // comparator order: the tied pair first (id-descending tie-break,
    // matching the ground truth above), then the older row last.
    expect(seen).toHaveLength(3);
    expect(seen[0]).toEqual({ kind: expectedFirst.kind, recordedAt: tied.getTime() });
    expect(seen[1]).toEqual({ kind: expectedSecond.kind, recordedAt: tied.getTime() });
    expect(seen[2]).toEqual({ kind: "p", recordedAt: older.getTime() });
    void olderRow;
  });

  it("empty page returns null nextCursor, no error", async () => {
    const { learnerCtx } = await setupScenario();
    const future = new Date(Date.now() + 60_000);
    const page = await getLearnerHistory(learnerCtx, { from: future });
    expect(page).toEqual({ items: [], nextCursor: null });
  });

  it("invalid cursor -> HistoryCursorError", async () => {
    const { learnerCtx } = await setupScenario();
    await expect(
      getLearnerHistory(learnerCtx, {}, { cursor: "not-valid-base64-json" })
    ).rejects.toThrow(HistoryCursorError);
  });

  it("a cursor issued in seq mode is rejected against a request whose filters changed mode", async () => {
    const { learnerCtx, skill } = await setupScenario();
    const seqPage = await getLearnerHistory(
      learnerCtx,
      { type: "PROFICIENCY_CHANGED", skillId: skill.id },
      { limit: 1 }
    );
    expect(seqPage.nextCursor).not.toBeNull();
    await expect(
      getLearnerHistory(learnerCtx, {}, { cursor: seqPage.nextCursor! })
    ).rejects.toThrow(HistoryCursorError);
  });

  it("pagination remains stable after a new event is inserted between pages", async () => {
    const { learnerCtx, orgAdmin, evidence1 } = await setupScenario();
    const page1 = await getLearnerHistory(learnerCtx, {}, { limit: 1 });
    const page1Key = (i: (typeof page1.items)[number]) =>
      i.type === "PROFICIENCY_CHANGED"
        ? `p:${i.skillId}:${i.cause}`
        : `s:${i.evidenceId}:${i.action}`;

    // Insert a brand-new, newer event between page fetches.
    await revokeEvidence(orgAdmin, evidence1.id, "test revoke between pages");

    const page2 = await getLearnerHistory(learnerCtx, {}, { limit: 1, cursor: page1.nextCursor! });
    // The keyset cursor is strictly "< the last seen position" — page2 must
    // be a genuinely different item than page1's, and the newly-inserted
    // REVOKE (newer than anything page1's cursor already passed) must NOT
    // appear in this "older" page.
    expect(page1Key(page1.items[0])).not.toBe(page1Key(page2.items[0]));
    expect(
      page2.items.some((i) => i.type === "EVIDENCE_STANDING_CHANGED" && i.action === "REVOKE")
    ).toBe(false);

    // A fresh fetch from the top (no cursor) DOES include the new REVOKE —
    // proving it was excluded from page2 by correct keyset position, not
    // because it silently failed to write.
    const fresh = await getLearnerHistory(learnerCtx, {}, { limit: 1 });
    expect(fresh.items[0].type === "EVIDENCE_STANDING_CHANGED" && fresh.items[0].action).toBe(
      "REVOKE"
    );
  });
});

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

describe("privacy", () => {
  it("no tenantId, raw actorId, or database id fields in the JSON response", async () => {
    const { orgAdmin, learner, tenant, evidence1 } = await setupScenario();
    const page = await getOrgLearnerHistory(orgAdmin, learner.id, {});
    const json = JSON.stringify(page);
    expect(json).not.toContain(tenant.id);
    expect(json).not.toContain(orgAdmin.userId);
    expect(json).not.toContain(learner.id);
    // evidenceId is an approved, exposed field (discovery §5) — not a leak.
    void evidence1;
  });

  it("BASELINE items never expose the internal migration-metadata reason string", async () => {
    const { tenant, learnerCtx, skill } = await setupScenario();
    const secondSkill = await createSkill(tenant.id);
    await db.userSkill.create({
      data: {
        tenantId: tenant.id,
        userId: learnerCtx.userId,
        skillId: secondSkill.id,
        proficiency: "BEGINNER",
      },
    });
    await backfillTenant(tenant.id);

    const raw = await db.skillProficiencyEvent.findFirstOrThrow({
      where: {
        tenantId: tenant.id,
        userId: learnerCtx.userId,
        skillId: secondSkill.id,
        cause: "BASELINE",
      },
    });
    expect(raw.reason).not.toBeNull();
    expect(raw.reason).toContain("backfill");

    const page = await getLearnerHistory(learnerCtx, { skillId: secondSkill.id });
    const baseline = page.items.find(
      (i) => i.type === "PROFICIENCY_CHANGED" && i.cause === "BASELINE"
    );
    expect(baseline).toBeDefined();
    if (baseline?.type === "PROFICIENCY_CHANGED") {
      expect(baseline.reason).toBeNull();
    }
    const json = JSON.stringify(page);
    expect(json).not.toContain("backfill");
    void skill;
  });

  it("reason is exposed only for EVIDENCE_REVOKED/EVIDENCE_REINSTATED causes and REVOKE/REINSTATE actions", async () => {
    const { learnerCtx, orgAdmin, evidence1 } = await setupScenario();
    await revokeEvidence(orgAdmin, evidence1.id, "integrity correction");

    const page = await getLearnerHistory(learnerCtx, {});
    const revoked = page.items.find(
      (i) => i.type === "EVIDENCE_STANDING_CHANGED" && i.action === "REVOKE"
    );
    expect(revoked?.type === "EVIDENCE_STANDING_CHANGED" && revoked.reason).toBe(
      "integrity correction"
    );

    const verified = page.items.find(
      (i) => i.type === "EVIDENCE_STANDING_CHANGED" && i.action === "VERIFY"
    );
    expect(verified?.type === "EVIDENCE_STANDING_CHANGED" && verified.reason).toBeNull();
  });

  it("a foreign tenant's course title never appears via a malformed/cross-tenant sourceId", async () => {
    const { tenant, learnerCtx, orgAdmin, skill } = await setupScenario();
    const { ctx: foreignInstructor } = await createTenantUser("INSTRUCTOR");
    const { course: foreignCourse } = await createCourse(
      foreignInstructor.tenantId,
      foreignInstructor.userId
    );

    // A malformed row: tenant A evidence whose sourceId points at tenant B's
    // course — exactly the "source ids MUST NOT be trusted" scenario
    // contract B8 exists for. Created directly (verifyEvidence would itself
    // refuse this via 30.3's own course-tenant check, verification.ts:240),
    // so a standing event is inserted directly too, to exercise the read
    // path against this specific malformed shape.
    const badEvidence = await db.skillEvidence.create({
      data: {
        tenantId: tenant.id,
        userId: learnerCtx.userId,
        skillId: skill.id,
        type: "COURSE_COMPLETION",
        sourceType: "Course",
        sourceId: foreignCourse.id,
      },
    });
    await db.evidenceStandingEvent.create({
      data: {
        tenantId: tenant.id,
        userId: learnerCtx.userId,
        skillId: skill.id,
        evidenceId: badEvidence.id,
        evidenceRevision: 0,
        action: "VERIFY",
        actorId: orgAdmin.userId,
        actorRole: "ORG_ADMIN",
        previousVerificationStatus: "UNVERIFIED",
        newVerificationStatus: "VERIFIED",
        previousState: "ACTIVE",
        newState: "ACTIVE",
      },
    });

    const orgPage = await getOrgLearnerHistory(orgAdmin, learnerCtx.userId, {
      evidenceId: badEvidence.id,
    });
    const learnerPage = await getLearnerHistory(learnerCtx, { evidenceId: badEvidence.id });
    expect(orgPage).not.toBeNull();
    for (const page of [orgPage!, learnerPage]) {
      expect(page.items.length).toBeGreaterThan(0);
      const json = JSON.stringify(page);
      expect(json).not.toContain(foreignCourse.title);
      const standing = page.items.find((i) => i.type === "EVIDENCE_STANDING_CHANGED");
      expect(standing).toBeDefined();
      expect(
        standing?.type === "EVIDENCE_STANDING_CHANGED" && standing.sourceContext.courseTitle
      ).toBeNull();
    }
  });

  it("a foreign tenant's course title never appears via a malformed cross-tenant Quiz sourceId (the nested lesson.section.course.tenantId branch)", async () => {
    // The Course branch above and this Quiz branch resolve through
    // structurally different queries (batchResolveSourceContext) — a
    // top-level `tenantId` predicate on Course.findMany vs. a nested
    // `lesson.section.course.tenantId` predicate on Quiz.findMany. Proving
    // one says nothing about the other; this test exercises the nested form
    // directly, since Quiz is the most common real sourceType in production.
    const { tenant, learnerCtx, orgAdmin, skill } = await setupScenario();
    const { ctx: foreignInstructor } = await createTenantUser("INSTRUCTOR");
    const { course: foreignCourse, lesson: foreignLesson } = await createCourse(
      foreignInstructor.tenantId,
      foreignInstructor.userId
    );
    const foreignQuiz = await createQuiz(foreignLesson.id);

    const badEvidence = await db.skillEvidence.create({
      data: {
        tenantId: tenant.id,
        userId: learnerCtx.userId,
        skillId: skill.id,
        type: "QUIZ_SCORE",
        sourceType: "Quiz",
        sourceId: foreignQuiz.id,
        score: 90,
      },
    });
    await db.evidenceStandingEvent.create({
      data: {
        tenantId: tenant.id,
        userId: learnerCtx.userId,
        skillId: skill.id,
        evidenceId: badEvidence.id,
        evidenceRevision: 0,
        action: "VERIFY",
        actorId: orgAdmin.userId,
        actorRole: "ORG_ADMIN",
        previousVerificationStatus: "UNVERIFIED",
        newVerificationStatus: "VERIFIED",
        previousState: "ACTIVE",
        newState: "ACTIVE",
      },
    });

    const orgPage = await getOrgLearnerHistory(orgAdmin, learnerCtx.userId, {
      evidenceId: badEvidence.id,
    });
    const learnerPage = await getLearnerHistory(learnerCtx, { evidenceId: badEvidence.id });
    expect(orgPage).not.toBeNull();
    for (const page of [orgPage!, learnerPage]) {
      expect(page.items.length).toBeGreaterThan(0);
      const json = JSON.stringify(page);
      expect(json).not.toContain(foreignCourse.title);
      const standing = page.items.find((i) => i.type === "EVIDENCE_STANDING_CHANGED");
      expect(standing).toBeDefined();
      expect(
        standing?.type === "EVIDENCE_STANDING_CHANGED" && standing.sourceContext.courseTitle
      ).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Read-only invariant
// ---------------------------------------------------------------------------

describe("read-only invariant", () => {
  it("a history read never writes to UserSkill, SkillEvidence, or either history table", async () => {
    const { tenant, learnerCtx, instructor1, orgAdmin, learner } = await setupScenario();

    const snapshot = async () => ({
      userSkill: await db.userSkill.findMany({
        where: { tenantId: tenant.id },
        orderBy: { id: "asc" },
      }),
      skillEvidence: await db.skillEvidence.findMany({
        where: { tenantId: tenant.id },
        orderBy: { id: "asc" },
      }),
      proficiencyEvents: await db.skillProficiencyEvent.findMany({
        where: { tenantId: tenant.id },
        orderBy: { id: "asc" },
      }),
      standingEvents: await db.evidenceStandingEvent.findMany({
        where: { tenantId: tenant.id },
        orderBy: { id: "asc" },
      }),
    });

    const before = await snapshot();
    await getLearnerHistory(learnerCtx, {});
    await getInstructorLearnerHistory(instructor1, learner.id, {});
    await getOrgLearnerHistory(orgAdmin, learner.id, {});
    const after = await snapshot();

    expect(after).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Performance — no N+1
// ---------------------------------------------------------------------------

describe("performance", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("query count stays bounded independent of page size", async () => {
    const { tenant, instructor1, learner, skill } = await setupScenario();
    // A wider fixture: several more skills/evidence rows for this learner.
    for (let i = 0; i < 8; i++) {
      const { course } = await createCourse(tenant.id, instructor1.userId);
      await mapCourseSkill(course.id, skill.id);
      await enroll(learner.id, course.id);
      await recordCourseCompletionEvidence({
        tenantId: tenant.id,
        userId: learner.id,
        courseId: course.id,
        occurredAt: new Date(),
      });
    }

    const spies = [
      vi.spyOn(db.skillProficiencyEvent, "findMany"),
      vi.spyOn(db.evidenceStandingEvent, "findMany"),
      vi.spyOn(db.skill, "findMany"),
      vi.spyOn(db.skillEvidence, "findMany"),
      vi.spyOn(db.course, "findMany"),
      vi.spyOn(db.quiz, "findMany"),
      vi.spyOn(db.quizAttempt, "findMany"),
      vi.spyOn(db.assignmentSubmission, "findMany"),
    ];

    const countCalls = () => spies.reduce((sum, s) => sum + s.mock.calls.length, 0);

    for (const s of spies) s.mockClear();
    await getInstructorLearnerHistory(instructor1, learner.id, {}, { limit: 1 });
    const smallPageCalls = countCalls();

    for (const s of spies) s.mockClear();
    await getInstructorLearnerHistory(instructor1, learner.id, {}, { limit: 100 });
    const largePageCalls = countCalls();

    // Bounded by a small constant, not by page size: the two counts may
    // differ slightly (a bigger page can touch one more distinct sourceType
    // than a 1-item page happens to), but neither may scale with the number
    // of items returned — the real N+1 property this test exists to prove.
    expect(Math.abs(largePageCalls - smallPageCalls)).toBeLessThanOrEqual(3);
    expect(smallPageCalls).toBeLessThan(15);
    expect(largePageCalls).toBeLessThan(15);
  });

  it("an empty authorized-evidence-id set short-circuits before any event query runs", async () => {
    // Instructor genuinely shares an enrollment with the learner, but the
    // learner has zero evidence resolving to THIS instructor's own courses
    // — a real, legal state (e.g. enrolled but not yet completed anything).
    const { tenant, ctx: instructor1 } = await createTenantUser("INSTRUCTOR");
    const { user: learner } = await createUserInTenant(tenant.id, "STUDENT");
    const { course } = await createCourse(tenant.id, instructor1.userId);
    await enroll(learner.id, course.id);

    const proficiencySpy = vi.spyOn(db.skillProficiencyEvent, "findMany");
    const standingSpy = vi.spyOn(db.evidenceStandingEvent, "findMany");

    const page = await getInstructorLearnerHistory(instructor1, learner.id, {});

    expect(page).toEqual({ items: [], nextCursor: null });
    // The whole point of the empty-array short-circuit (queryProficiencyPage/
    // queryStandingPage) is to never issue the always-empty query at all —
    // Prisma's own `in: []` would also correctly return zero rows without
    // the guard, so this is the one place that guard's purpose (skipping a
    // wasted round trip, not correctness) is actually observable.
    expect(proficiencySpy).not.toHaveBeenCalled();
    expect(standingSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// evidenceId filter — must apply in every ordering mode, not only "revision"
// mode (mutation-driven: a first implementation applied it only when the
// request also narrowed type=EVIDENCE_STANDING_CHANGED, silently ignoring it
// for every other combination — a real bug a mocked route test could not
// have caught, since it only proves the filter value reaches the domain
// call, not that the domain call actually uses it).
// ---------------------------------------------------------------------------

describe("evidenceId filter", () => {
  it("org: evidenceId alone (no type narrowing) restricts to that evidence's events from both tables", async () => {
    const { orgAdmin, learner, evidence1, evidence2 } = await setupScenario();
    const page = await getOrgLearnerHistory(orgAdmin, learner.id, { evidenceId: evidence1.id });
    expect(page).not.toBeNull();
    expect(page!.items.length).toBeGreaterThan(0);
    for (const item of page!.items) {
      if (item.type === "EVIDENCE_STANDING_CHANGED") expect(item.evidenceId).toBe(evidence1.id);
      if (item.type === "PROFICIENCY_CHANGED" && item.evidenceId !== null) {
        expect(item.evidenceId).toBe(evidence1.id);
      }
    }
    expect(
      page!.items.some(
        (i) => i.type === "EVIDENCE_STANDING_CHANGED" && i.evidenceId === evidence2.id
      )
    ).toBe(false);
  });

  it("instructor: evidenceId alone for an UNAUTHORIZED evidence id returns empty, not the whole authorized set", async () => {
    const { instructor1, learner, evidence2 } = await setupScenario();
    const page = await getInstructorLearnerHistory(instructor1, learner.id, {
      evidenceId: evidence2.id,
    });
    expect(page).toEqual({ items: [], nextCursor: null });
  });

  it("instructor: evidenceId + type=PROFICIENCY_CHANGED restricts to that evidence's proficiency events only", async () => {
    // Two DIFFERENT skills, each with its own instructor1-owned evidence, so
    // each independently produces its own EVIDENCE_ADDED event with a
    // distinct evidenceId — unlike setupScenario's shared-skill fixture,
    // where every proficiency event happens to carry the same evidenceId
    // regardless of whether the evidenceId filter is actually applied,
    // which would let a mutant that drops the filter survive undetected.
    const { tenant, ctx: instructor1 } = await createTenantUser("INSTRUCTOR");
    const { user: learner } = await createUserInTenant(tenant.id, "STUDENT");
    const skillA = await createSkill(tenant.id);
    const skillB = await createSkill(tenant.id);
    const { course: courseA } = await createCourse(tenant.id, instructor1.userId);
    const { course: courseB } = await createCourse(tenant.id, instructor1.userId);
    await mapCourseSkill(courseA.id, skillA.id);
    await mapCourseSkill(courseB.id, skillB.id);
    await db.enrollment.create({
      data: {
        userId: learner.id,
        courseId: courseA.id,
        status: "COMPLETED",
        completedAt: new Date(),
      },
    });
    await db.enrollment.create({
      data: {
        userId: learner.id,
        courseId: courseB.id,
        status: "COMPLETED",
        completedAt: new Date(),
      },
    });
    await recordCourseCompletionEvidence({
      tenantId: tenant.id,
      userId: learner.id,
      courseId: courseA.id,
      occurredAt: new Date(),
    });
    await recordCourseCompletionEvidence({
      tenantId: tenant.id,
      userId: learner.id,
      courseId: courseB.id,
      occurredAt: new Date(),
    });
    const evidenceA = await db.skillEvidence.findFirstOrThrow({
      where: { userId: learner.id, sourceId: courseA.id },
    });
    const evidenceB = await db.skillEvidence.findFirstOrThrow({
      where: { userId: learner.id, sourceId: courseB.id },
    });

    const page = await getInstructorLearnerHistory(instructor1, learner.id, {
      evidenceId: evidenceA.id,
      type: "PROFICIENCY_CHANGED",
    });
    expect(page).not.toBeNull();
    expect(page!.items.length).toBeGreaterThan(0);
    for (const item of page!.items) {
      expect(item.type).toBe("PROFICIENCY_CHANGED");
      if (item.type === "PROFICIENCY_CHANGED") expect(item.evidenceId).toBe(evidenceA.id);
    }
    expect(
      page!.items.some((i) => i.type === "PROFICIENCY_CHANGED" && i.evidenceId === evidenceB.id)
    ).toBe(false);
  });
});

describe("security", () => {
  it("cross-tenant learnerId on the instructor route returns null, not a distinguishable result from an unrelated learner", async () => {
    const { instructor1 } = await setupScenario();
    const { user: foreignLearner } = await createTenantUser("STUDENT");
    const result1 = await getInstructorLearnerHistory(instructor1, foreignLearner.id, {});
    const { tenant } = await createTenantUser("STUDENT");
    const { user: unrelatedSameTenantLearner } = await createUserInTenant(tenant.id, "STUDENT");
    const result2 = await getInstructorLearnerHistory(
      instructor1,
      unrelatedSameTenantLearner.id,
      {}
    );
    expect(result1).toBeNull();
    expect(result2).toBeNull();
  });

  it("a tampered cursor (flipped mode byte) is rejected, never silently reinterpreted", async () => {
    const { learnerCtx } = await setupScenario();
    const page = await getLearnerHistory(learnerCtx, {}, { limit: 1 });
    const tampered = Buffer.from(
      JSON.stringify({ m: "rec", t: "not-a-real-date", id: "x" }),
      "utf8"
    ).toString("base64");
    await expect(getLearnerHistory(learnerCtx, {}, { cursor: tampered })).rejects.toThrow(
      HistoryCursorError
    );
    void page;
  });

  it("an authorized instructor requesting a specific unauthorized evidenceId in revision mode gets an empty page, not another instructor's data", async () => {
    const { instructor1, learner, evidence2 } = await setupScenario();
    const page = await getInstructorLearnerHistory(
      instructor1,
      learner.id,
      { type: "EVIDENCE_STANDING_CHANGED", evidenceId: evidence2.id },
      {}
    );
    expect(page).toEqual({ items: [], nextCursor: null });
  });
});

// ---------------------------------------------------------------------------
// Defense-in-depth: tenant predicates must never be trusted-through via a
// unique id alone (mutation-driven — these regression tests were added
// after a mutation pass found the tenantId predicate on the event queries
// and on the instructor's enrollment-ownership check both survived when
// removed, because a real userId/instructorId is globally unique in this
// schema and therefore already implies the correct tenant in every fixture
// built from a genuine AuthContext. A caller passing a WRONG tenantId
// alongside a real userId is the only way to observe the predicate doing
// its own, independent work — exactly the scenario the repo's own
// "never trust ownership alone to imply tenant scope" convention exists
// for (instructorReport.ts/organizationReport.ts's own comments).
// ---------------------------------------------------------------------------

describe("defense-in-depth — tenant predicates are not redundant", () => {
  it("getLearnerHistory returns nothing if ctx.tenantId is wrong, even though ctx.userId is real", async () => {
    const { learnerCtx } = await setupScenario();
    const { tenant: wrongTenant } = await createTenantUser("STUDENT");
    const spoofedCtx = { ...learnerCtx, tenantId: wrongTenant.id };

    const page = await getLearnerHistory(spoofedCtx, {});
    expect(page.items).toEqual([]);
  });

  it("getInstructorLearnerHistory's ownership check fails closed if ctx.tenantId is wrong, even with the real instructor userId", async () => {
    const { instructor1, learner } = await setupScenario();
    const { tenant: wrongTenant } = await createTenantUser("STUDENT");
    const spoofedCtx = { ...instructor1, tenantId: wrongTenant.id };

    const page = await getInstructorLearnerHistory(spoofedCtx, learner.id, {});
    expect(page).toBeNull();
  });

  it("the enrollment-ownership check's own tenantId predicate is load-bearing, isolated from the learner-existence check", async () => {
    // A malformed Enrollment linking a real learner in tenant B to a real
    // course in tenant A — Prisma enforces no FK-level tenant consistency
    // between User/Course/Enrollment (contract B8: "evidence source ids
    // MUST NOT be trusted"), so this state, while abnormal, is not
    // structurally impossible. ctx.tenantId is spoofed to B (the learner's
    // OWN real tenant), so the separate learner-existence check would pass
    // regardless — isolating the enrollment/course tenantId predicate as
    // the only thing standing between "authorized" and not.
    const { tenant: tenantA, ctx: instructor1 } = await createTenantUser("INSTRUCTOR");
    const { course } = await createCourse(tenantA.id, instructor1.userId);
    const { tenant: tenantB } = await createTenantUser("STUDENT");
    const { user: learnerInB } = await createUserInTenant(tenantB.id, "STUDENT");
    await db.enrollment.create({
      data: { userId: learnerInB.id, courseId: course.id, status: "COMPLETED" },
    });

    const spoofedCtx = { ...instructor1, tenantId: tenantB.id };
    const page = await getInstructorLearnerHistory(spoofedCtx, learnerInB.id, {});
    expect(page).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Ordering boundary regressions (mutation-driven)
// ---------------------------------------------------------------------------

describe("ordering boundaries", () => {
  it("seq-mode pagination visits every event exactly once, newest first, no duplicate at the page boundary", async () => {
    const { tenant, ctx: instructor1 } = await createTenantUser("INSTRUCTOR");
    const { ctx: orgAdmin } = await createUserInTenant(tenant.id, "ORG_ADMIN");
    const { user: learner, ctx: learnerCtx } = await createUserInTenant(tenant.id, "STUDENT");
    const skill = await createSkill(tenant.id);
    const { course } = await createCourse(tenant.id, instructor1.userId);
    await mapCourseSkill(course.id, skill.id);
    await db.enrollment.create({
      data: {
        userId: learner.id,
        courseId: course.id,
        status: "COMPLETED",
        completedAt: new Date(),
      },
    });
    // A single evidence row driven through four genuine, level-changing
    // transitions (30.2's own rule: SkillProficiencyEvent fires only when
    // the level actually changes) — more course completions on one skill
    // would NOT produce more events once the ceiling is reached, so real
    // transitions are the only way to get several distinct `seq` values.
    await recordCourseCompletionEvidence({
      tenantId: tenant.id,
      userId: learner.id,
      courseId: course.id,
      occurredAt: new Date(),
    }); // seq 1: NONE -> BEGINNER
    const evidence = await db.skillEvidence.findFirstOrThrow({
      where: { userId: learner.id, sourceId: course.id },
    });
    await verifyEvidence(instructor1, evidence.id); // seq 2: BEGINNER -> INTERMEDIATE
    await revokeEvidence(orgAdmin, evidence.id, "seq boundary test"); // seq 3: INTERMEDIATE -> NONE
    await reinstateEvidence(orgAdmin, evidence.id, "seq boundary test"); // seq 4: NONE -> INTERMEDIATE

    const events = await db.skillProficiencyEvent.findMany({
      where: { tenantId: tenant.id, userId: learner.id, skillId: skill.id },
      orderBy: { seq: "asc" },
    });
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);

    const seen: number[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 4; i++) {
      const page = await getLearnerHistory(
        learnerCtx,
        { type: "PROFICIENCY_CHANGED", skillId: skill.id },
        { limit: 1, cursor }
      );
      expect(page.items).toHaveLength(1);
      const item = page.items[0];
      expect(item.type).toBe("PROFICIENCY_CHANGED");
      if (item.type === "PROFICIENCY_CHANGED") {
        const raw = await db.skillProficiencyEvent.findFirstOrThrow({
          where: {
            tenantId: tenant.id,
            userId: learner.id,
            skillId: skill.id,
            cause: item.cause,
            newProficiency: item.newProficiency,
            recordedAt: item.recordedAt,
          },
        });
        seen.push(raw.seq);
      }
      cursor = page.nextCursor ?? undefined;
    }
    expect(seen).toEqual([4, 3, 2, 1]);
    // After the oldest (seq 1) event, nextCursor is null — confirmed here,
    // not by fetching "one more page" with cursor=undefined, which would
    // indistinguishably restart pagination from the top instead.
    expect(cursor).toBeUndefined();
  });

  it("PROFICIENCY_CHANGED-only (no skillId) results are strictly newest-first", async () => {
    const { tenant, learnerCtx } = await setupScenario();
    // Explicit, widely-spread recordedAt values — real writers can land in
    // the same DB millisecond under fast test execution, which would make a
    // reversed-order mutant pass by accident (a tied array looks "sorted"
    // both ways). Direct row creation removes that ambiguity.
    const skillA = await createSkill(tenant.id);
    const skillB = await createSkill(tenant.id);
    const skillC = await createSkill(tenant.id);
    const base = Date.now();
    const rows = await Promise.all(
      [
        { skillId: skillA.id, seq: 1, at: new Date(base - 20_000) },
        { skillId: skillB.id, seq: 1, at: new Date(base - 10_000) },
        { skillId: skillC.id, seq: 1, at: new Date(base) },
      ].map((r) =>
        db.skillProficiencyEvent.create({
          data: {
            tenantId: tenant.id,
            userId: learnerCtx.userId,
            skillId: r.skillId,
            seq: r.seq,
            cause: "EVIDENCE_ADDED",
            newProficiency: "BEGINNER",
            policyVersion: 1,
            occurredAt: r.at,
            recordedAt: r.at,
          },
        })
      )
    );
    const newestId = rows[2].id;
    const oldestId = rows[0].id;

    const page = await getLearnerHistory(learnerCtx, { type: "PROFICIENCY_CHANGED" }, { limit: 1 });
    expect(page.items).toHaveLength(1);
    const top = page.items[0];
    expect(top.type).toBe("PROFICIENCY_CHANGED");
    if (top.type === "PROFICIENCY_CHANGED") {
      const topRow = await db.skillProficiencyEvent.findFirstOrThrow({
        where: { skillId: top.skillId, cause: top.cause, recordedAt: top.recordedAt },
      });
      expect(topRow.id).toBe(newestId);
      expect(topRow.id).not.toBe(oldestId);
    }
  });

  it("two events sharing the exact same recordedAt millisecond are still ordered deterministically by id (tie-break)", async () => {
    const { tenant, learnerCtx } = await setupScenario();
    const sharedTimestamp = new Date();
    const skill = await createSkill(tenant.id);
    const evA = await db.skillEvidence.create({
      data: {
        tenantId: tenant.id,
        userId: learnerCtx.userId,
        skillId: skill.id,
        type: "MANUAL",
        sourceType: "Manual",
        sourceId: null,
      },
    });
    const rowA = await db.skillProficiencyEvent.create({
      data: {
        tenantId: tenant.id,
        userId: learnerCtx.userId,
        skillId: skill.id,
        seq: 1,
        cause: "EVIDENCE_ADDED",
        evidenceId: evA.id,
        evidenceRevision: 0,
        newProficiency: "BEGINNER",
        policyVersion: 1,
        occurredAt: sharedTimestamp,
        recordedAt: sharedTimestamp,
      },
    });
    const evB = await db.skillEvidence.create({
      data: {
        tenantId: tenant.id,
        userId: learnerCtx.userId,
        skillId: skill.id,
        type: "MANUAL",
        sourceType: "Manual",
        sourceId: null,
      },
    });
    const rowB = await db.skillProficiencyEvent.create({
      data: {
        tenantId: tenant.id,
        userId: learnerCtx.userId,
        skillId: skill.id,
        seq: 2,
        cause: "EVIDENCE_ADDED",
        evidenceId: evB.id,
        evidenceRevision: 0,
        newProficiency: "BEGINNER",
        policyVersion: 1,
        occurredAt: sharedTimestamp,
        recordedAt: sharedTimestamp,
      },
    });

    const [expectedFirst, expectedSecond] = rowA.id > rowB.id ? [rowA, rowB] : [rowB, rowA];

    // Deliberately NOT filtering by skillId here — that combination would
    // select "seq" ordering mode (determineOrderingMode), which doesn't use
    // compareDesc's tie-break at all. type-only keeps this in "recorded"
    // mode, the branch that actually exercises the tie-break being tested.
    const page = await getLearnerHistory(learnerCtx, { type: "PROFICIENCY_CHANGED" }, { limit: 2 });
    const ids = page.items
      .filter((i) => i.skillId === skill.id)
      .map((i) => (i.type === "PROFICIENCY_CHANGED" ? i.evidenceId : null));
    expect(ids).toEqual([expectedFirst.evidenceId, expectedSecond.evidenceId]);
  });
});

// ---------------------------------------------------------------------------
// Final-sweep regressions (a broader 33-mutant sweep against the final files
// found these six predicates unpinned): revision-mode cursor, action-based
// reason allowlist, date boundaries, and three cross-tenant lookups that only
// malformed rows can exercise.
// ---------------------------------------------------------------------------

describe("final-sweep regressions", () => {
  it("revision-mode pagination visits each standing event exactly once, newest revision first", async () => {
    const { tenant, orgAdmin, evidence1 } = await setupScenario();
    await revokeEvidence(orgAdmin, evidence1.id, "integrity correction");
    await reinstateEvidence(orgAdmin, evidence1.id, "restored");

    const filters = { type: "EVIDENCE_STANDING_CHANGED" as const, evidenceId: evidence1.id };
    const actions: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 6; i++) {
      const page = await getOrgLearnerHistory(orgAdmin, evidence1.userId, filters, {
        limit: 1,
        cursor,
      });
      expect(page).not.toBeNull();
      for (const item of page!.items) {
        if (item.type === "EVIDENCE_STANDING_CHANGED") actions.push(item.action);
      }
      cursor = page!.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(actions).toEqual(["REINSTATE", "REVOKE", "VERIFY"]);
    void tenant;
  });

  it("a non-REVOKE/REINSTATE standing row never exposes its reason, even if the column holds text", async () => {
    const { tenant, orgAdmin, learnerCtx, skill, evidence1 } = await setupScenario();
    await db.evidenceStandingEvent.create({
      data: {
        tenantId: tenant.id,
        userId: learnerCtx.userId,
        skillId: skill.id,
        evidenceId: evidence1.id,
        evidenceRevision: 99,
        action: "VERIFY",
        actorId: orgAdmin.userId,
        actorRole: "ORG_ADMIN",
        previousVerificationStatus: "UNVERIFIED",
        newVerificationStatus: "VERIFIED",
        previousState: "ACTIVE",
        newState: "ACTIVE",
        reason: "internal-note-must-not-leak",
      },
    });

    const orgPage = await getOrgLearnerHistory(orgAdmin, learnerCtx.userId, {
      evidenceId: evidence1.id,
    });
    const learnerPage = await getLearnerHistory(learnerCtx, { evidenceId: evidence1.id });
    for (const page of [orgPage!, learnerPage]) {
      expect(JSON.stringify(page)).not.toContain("internal-note-must-not-leak");
    }
  });

  it("date range is [from, to): an event exactly at `to` is excluded, exactly at `from` is included", async () => {
    const { learnerCtx } = await setupScenario();
    const all = await getLearnerHistory(learnerCtx, { type: "EVIDENCE_STANDING_CHANGED" });
    const first = all.items[all.items.length - 1];
    const at = first.occurredAt;

    const before = await getLearnerHistory(learnerCtx, {
      type: "EVIDENCE_STANDING_CHANGED",
      to: at,
    });
    expect(before.items.every((i) => i.occurredAt.getTime() < at.getTime())).toBe(true);

    const exact = await getLearnerHistory(learnerCtx, {
      type: "EVIDENCE_STANDING_CHANGED",
      from: at,
      to: new Date(at.getTime() + 1),
    });
    expect(exact.items.length).toBeGreaterThan(0);
    expect(exact.items.every((i) => i.occurredAt.getTime() === at.getTime())).toBe(true);
  });

  it("a foreign tenant's skill name never appears via a malformed cross-tenant skillId", async () => {
    const { tenant, orgAdmin, learnerCtx, evidence1 } = await setupScenario();
    const { tenant: foreignTenant } = await createTenantUser("INSTRUCTOR");
    const foreignSkill = await createSkill(foreignTenant.id);
    await db.evidenceStandingEvent.create({
      data: {
        tenantId: tenant.id,
        userId: learnerCtx.userId,
        skillId: foreignSkill.id,
        evidenceId: evidence1.id,
        evidenceRevision: 98,
        action: "VERIFY",
        actorId: orgAdmin.userId,
        actorRole: "ORG_ADMIN",
        previousVerificationStatus: "UNVERIFIED",
        newVerificationStatus: "VERIFIED",
        previousState: "ACTIVE",
        newState: "ACTIVE",
      },
    });

    const page = await getOrgLearnerHistory(orgAdmin, learnerCtx.userId, {
      skillId: foreignSkill.id,
    });
    expect(page!.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(page)).not.toContain(foreignSkill.name);
    for (const item of page!.items) expect(item.skillName).toBe("");
  });

  it("evidence metadata from another tenant is never resolved for a tenant's own standing event", async () => {
    const { tenant, orgAdmin, learnerCtx, skill, course1 } = await setupScenario();
    const { ctx: foreignUser } = await createTenantUser("INSTRUCTOR");
    const foreignSkill = await createSkill(foreignUser.tenantId);
    const foreignEvidence = await db.skillEvidence.create({
      data: {
        tenantId: foreignUser.tenantId,
        userId: foreignUser.userId,
        skillId: foreignSkill.id,
        type: "COURSE_COMPLETION",
        sourceType: "Course",
        sourceId: course1.id,
      },
    });
    await db.evidenceStandingEvent.create({
      data: {
        tenantId: tenant.id,
        userId: learnerCtx.userId,
        skillId: skill.id,
        evidenceId: foreignEvidence.id,
        evidenceRevision: 0,
        action: "VERIFY",
        actorId: orgAdmin.userId,
        actorRole: "ORG_ADMIN",
        previousVerificationStatus: "UNVERIFIED",
        newVerificationStatus: "VERIFIED",
        previousState: "ACTIVE",
        newState: "ACTIVE",
      },
    });

    const page = await getOrgLearnerHistory(orgAdmin, learnerCtx.userId, {
      evidenceId: foreignEvidence.id,
    });
    const item = page!.items.find((i) => i.type === "EVIDENCE_STANDING_CHANGED");
    expect(item?.type === "EVIDENCE_STANDING_CHANGED" && item.evidenceType).toBe("MANUAL");
    expect(item?.type === "EVIDENCE_STANDING_CHANGED" && item.sourceContext.courseTitle).toBeNull();
  });

  it("instructor authorization never counts evidence rows stored under another tenant", async () => {
    const { tenant, instructor1, orgAdmin, learnerCtx, skill, course1, learner } =
      await setupScenario();
    const { ctx: foreignUser } = await createTenantUser("INSTRUCTOR");
    const foreignSkill = await createSkill(foreignUser.tenantId);
    const foreignEvidence = await db.skillEvidence.create({
      data: {
        tenantId: foreignUser.tenantId,
        userId: learnerCtx.userId,
        skillId: foreignSkill.id,
        type: "COURSE_COMPLETION",
        sourceType: "Course",
        sourceId: course1.id,
      },
    });
    await db.evidenceStandingEvent.create({
      data: {
        tenantId: tenant.id,
        userId: learnerCtx.userId,
        skillId: skill.id,
        evidenceId: foreignEvidence.id,
        evidenceRevision: 0,
        action: "VERIFY",
        actorId: orgAdmin.userId,
        actorRole: "ORG_ADMIN",
        previousVerificationStatus: "UNVERIFIED",
        newVerificationStatus: "VERIFIED",
        previousState: "ACTIVE",
        newState: "ACTIVE",
      },
    });

    const page = await getInstructorLearnerHistory(instructor1, learner.id, {
      type: "EVIDENCE_STANDING_CHANGED",
    });
    expect(page!.items.length).toBeGreaterThan(0);
    expect(
      page!.items.some(
        (i) => i.type === "EVIDENCE_STANDING_CHANGED" && i.evidenceId === foreignEvidence.id
      )
    ).toBe(false);
  });
});
