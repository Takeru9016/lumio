import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { prerequisiteWorld } from "@/lib/domain/course/__test__/prerequisiteFixtures";
import { getUnmetPrerequisites } from "@/lib/domain/course/prerequisites";
import { buildNewPath } from "@/lib/domain/learning-path/inputRules";
import { assertTransition } from "@/lib/domain/learning-path/lifecycle";
import { assertCourseMayJoin, assertCourseMayLeave } from "@/lib/domain/learning-path/membership";
import {
  nextPosition,
  planReorder,
  positionsAfterRemoval,
  sortMembers,
} from "@/lib/domain/learning-path/ordering";
import { derivePathProgress } from "@/lib/domain/learning-path/progress";
import { assessPublishability } from "@/lib/domain/learning-path/publishability";

afterAll(async () => {
  await db.$disconnect();
});

const MODULE_DIR = path.dirname(new URL(import.meta.url).pathname);

const moduleSources = () =>
  readdirSync(MODULE_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => ({ file: f, text: readFileSync(path.join(MODULE_DIR, f), "utf8") }));

// The one file that reads and writes the database. Everything else is pure, and
// the checks that forbid a database client or a Prisma call apply to it alone.
const DATABASE_BACKED = ["paths.ts"];
const pureSources = () => moduleSources().filter((s) => !DATABASE_BACKED.includes(s.file));

describe("the learning path domain stands apart from enrollment, prerequisites and everything else", () => {
  it("has source files to inspect", () => {
    expect(moduleSources().map((s) => s.file)).toEqual(
      expect.arrayContaining([
        "availability.ts",
        "constants.ts",
        "inputRules.ts",
        "lifecycle.ts",
        "listing.ts",
        "membership.ts",
        "ordering.ts",
        "paths.ts",
        "progress.ts",
        "publishability.ts",
        "types.ts",
      ])
    );
  });

  it.each([
    [
      "the prerequisite module and its gate",
      /course\/prerequisites|assertCoursePrerequisitesMet|getUnmetPrerequisites/,
    ],
    ["the assignment domain (its pure id check aside)", /learning-assignment\/(?!inputRules)/],
    ["notifications", /notifications/],
    ["learning events", /learning-events|LEARNING_PATH_COMPLETED/],
    ["capability and evidence", /domain\/capability|SkillEvidence|skillEvidence/],
    ["enrollment access or payment", /enrollmentAccess|paymentVerification|razorpay/i],
    ["prerequisite rows", /coursePrerequisite|CoursePrerequisite/],
    ["AI", /lib\/ai|openai|streamText|generateText|@ai-sdk/i],
  ])("imports or touches no %s, in any file of the module", (_name, pattern) => {
    for (const { file, text } of moduleSources()) {
      expect(text.match(pattern), `${file} must not match ${pattern}`).toBeNull();
    }
  });

  it.each([
    ["the database client", /@\/lib\/db/],
    [
      "Prisma client calls",
      /\.(create|update|delete|upsert|findMany|findFirst|findUnique|\$transaction|\$queryRaw|\$executeRaw)\(/,
    ],
    ["raw SQL", /\$queryRaw|\$executeRaw/],
  ])("imports or touches no %s, in any file but the database-backed one", (_name, pattern) => {
    for (const { file, text } of pureSources()) {
      expect(text.match(pattern), `${file} must not match ${pattern}`).toBeNull();
    }
  });

  it("the database-backed file reads and writes only paths, memberships, and the courses and lessons it inspects", () => {
    const source = moduleSources().find((s) => s.file === "paths.ts")?.text ?? "";
    const delegates = new Set(
      [...source.matchAll(/\b(?:db|tx|client)\.([a-zA-Z]+)\.[a-zA-Z]+\(/g)].map((m) => m[1])
    );
    expect([...delegates].sort()).toEqual(
      ["course", "learningPath", "learningPathCourse", "section"].sort()
    );

    const tables = new Set(
      [...source.matchAll(/(?:FROM|UPDATE|INTO)\s+"([A-Za-z]+)"/g)].map((m) => m[1])
    );
    expect([...tables].sort()).toEqual(["LearningPath", "LearningPathCourse"]);
  });
});

describe("path operations never create, change or remove a CoursePrerequisite", () => {
  it("adding, ordering, removing, publishing and archiving leave prerequisites and everything a learner owns untouched", async () => {
    const w = await prerequisiteWorld();
    const [a, b, c] = await Promise.all([w.make(), w.make(), w.make()]);
    await w.requires(b.id, a.id); // b requires a; the path will put b BEFORE a
    const learner = w.learner.user.id;

    const prerequisiteRows = () =>
      db.coursePrerequisite.findMany({
        where: { course: { tenantId: w.tenant.id } },
        orderBy: { id: "asc" },
      });
    const learnerRows = async () => ({
      enrollments: await db.enrollment.count({ where: { userId: learner } }),
      assignments: await db.learningAssignment.count({ where: { userId: learner } }),
      notifications: await db.notification.count({ where: { userId: learner } }),
      events: await db.learningEvent.count({ where: { userId: learner } }),
      evidence: await db.skillEvidence.count({ where: { userId: learner } }),
    });
    const before = { prerequisites: await prerequisiteRows(), learner: await learnerRows() };
    const unmetBefore = await getUnmetPrerequisites(db, { userId: learner, courseId: b.id });
    const unchanged = async () => {
      expect(await prerequisiteRows()).toEqual(before.prerequisites);
      expect(await learnerRows()).toEqual(before.learner);
    };

    // create
    const created = await db.learningPath.create({
      data: buildNewPath(w.admin.ctx, { title: "Journey" }),
    });
    expect(created).toMatchObject({
      tenantId: w.tenant.id,
      createdById: w.admin.user.id,
      status: "DRAFT",
    });
    await unchanged();

    // add, b first and a second: an order that contradicts the prerequisite
    const facts = (id: string) => ({
      id,
      title: id,
      tenantId: w.tenant.id,
      status: "PUBLISHED" as const,
      hasPublishedLesson: true,
    });
    let members: { courseId: string; position: number }[] = [];
    for (const course of [b, a, c]) {
      assertCourseMayJoin({
        path: {
          tenantId: created.tenantId,
          status: created.status,
          members: members.map((m) => ({ id: m.courseId })),
        },
        course: facts(course.id),
      });
      const position = nextPosition(members.map((m) => m.position));
      await db.learningPathCourse.create({
        data: { pathId: created.id, courseId: course.id, position },
      });
      members = [...members, { courseId: course.id, position }];
      await unchanged();
    }
    expect(sortMembers(members).map((m) => m.courseId)).toEqual([b.id, a.id, c.id]);

    // the path's order did not turn into a requirement, and did not remove the real one
    expect(await getUnmetPrerequisites(db, { userId: learner, courseId: b.id })).toEqual(
      unmetBefore
    );
    expect(unmetBefore.map((u) => u.slug)).toEqual([a.slug]);

    // reorder
    for (const plan of [
      planReorder(
        members.map((m) => m.courseId),
        [c.id, a.id, b.id]
      ),
    ]) {
      await db.$transaction(
        plan.map((p) =>
          db.learningPathCourse.update({
            where: { pathId_courseId: { pathId: created.id, courseId: p.courseId } },
            data: { position: p.position },
          })
        )
      );
    }
    await unchanged();

    // remove
    const current = await db.learningPathCourse.findMany({
      where: { pathId: created.id },
      select: { courseId: true, position: true },
    });
    assertCourseMayLeave({
      path: { tenantId: w.tenant.id, status: "DRAFT", members: [a, b, c].map((x) => facts(x.id)) },
      courseId: a.id,
    });
    await db.learningPathCourse.delete({
      where: { pathId_courseId: { pathId: created.id, courseId: a.id } },
    });
    for (const p of positionsAfterRemoval(current, a.id)) {
      await db.learningPathCourse.update({
        where: { pathId_courseId: { pathId: created.id, courseId: p.courseId } },
        data: { position: p.position },
      });
    }
    await unchanged();

    // publish, then archive
    expect(
      assessPublishability({
        title: "Journey",
        tenantId: w.tenant.id,
        courses: [b, c].map((x) => facts(x.id)),
      }).publishable
    ).toBe(true);
    assertTransition("DRAFT", "PUBLISHED");
    await db.learningPath.update({
      where: { id: created.id },
      data: { status: "PUBLISHED", publishedAt: new Date() },
    });
    await unchanged();
    assertTransition("PUBLISHED", "ARCHIVED");
    await db.learningPath.update({ where: { id: created.id }, data: { status: "ARCHIVED" } });
    await unchanged();

    // progress is derived and reads nothing it can write
    derivePathProgress([
      { courseId: b.id, status: "PUBLISHED", hasPublishedLesson: true, enrollmentStatus: null },
    ]);
    await unchanged();
    expect(await getUnmetPrerequisites(db, { userId: learner, courseId: b.id })).toEqual(
      unmetBefore
    );
  });
});
