import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { prerequisiteWorld } from "@/lib/domain/course/__test__/prerequisiteFixtures";
import { createTenant } from "@/lib/domain/learning-assignment/__test__/fixtures";

afterAll(async () => {
  await db.$disconnect();
});

async function newPath(tenantId: string, createdById?: string) {
  return db.learningPath.create({
    data: { tenantId, title: "A path", ...(createdById ? { createdById } : {}) },
  });
}

type DbError = {
  code?: string;
  message?: string;
  meta?: { driverAdapterError?: { cause?: { originalCode?: string } } };
};

/** The Postgres SQLSTATE of the failure: 23502 not-null, 23503 foreign key, 23505 unique. */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    const e = err as DbError;
    return e.meta?.driverAdapterError?.cause?.originalCode ?? e.code ?? String(e.message);
  }
  return "OK";
}

describe("LearningPath — columns and defaults", () => {
  it("starts as a DRAFT with no publishedAt, description or creator", async () => {
    const w = await prerequisiteWorld();

    const path = await newPath(w.tenant.id);

    expect(path).toMatchObject({
      tenantId: w.tenant.id,
      status: "DRAFT",
      publishedAt: null,
      description: null,
      createdById: null,
    });
  });

  it("has exactly the agreed columns: no slug, archivedAt, updatedById, progress or enrollment fields", async () => {
    const rows = await db.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'LearningPath' ORDER BY column_name`;

    expect(rows.map((r) => r.column_name)).toEqual([
      "createdAt",
      "createdById",
      "description",
      "id",
      "publishedAt",
      "status",
      "tenantId",
      "title",
      "updatedAt",
    ]);
  });

  it("LearningPathCourse has exactly id, pathId, courseId, position, createdAt: no tenantId", async () => {
    const rows = await db.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'LearningPathCourse' ORDER BY column_name`;

    expect(rows.map((r) => r.column_name)).toEqual([
      "courseId",
      "createdAt",
      "id",
      "pathId",
      "position",
    ]);
  });

  it("the status enum is DRAFT, PUBLISHED, ARCHIVED and is its own type, not CourseStatus", async () => {
    const [{ labels }] = await db.$queryRaw<{ labels: string }[]>`
      SELECT array_to_string(enum_range(NULL::"LearningPathStatus"), ',') AS labels`;
    const [{ data_type, udt_name }] = await db.$queryRaw<{ data_type: string; udt_name: string }[]>`
      SELECT data_type, udt_name FROM information_schema.columns
      WHERE table_name = 'LearningPath' AND column_name = 'status'`;

    expect(labels).toBe("DRAFT,PUBLISHED,ARCHIVED");
    expect(data_type).toBe("USER-DEFINED");
    expect(udt_name).toBe("LearningPathStatus");
  });

  it("there are no path enrollment, progress, evidence, assignment, completion or notification tables", async () => {
    const rows = await db.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name ILIKE '%path%' ORDER BY table_name`;

    expect(rows.map((r) => r.table_name)).toEqual(["LearningPath", "LearningPathCourse"]);
  });
});

describe("LearningPath — tenant ownership", () => {
  it("tenantId cannot be null", async () => {
    const code = await codeOf(
      db.$executeRaw`INSERT INTO "LearningPath" ("id","tenantId","title","updatedAt")
        VALUES (${`p-${Math.random()}`}, NULL, 't', now())`
    );

    expect(code).toBe("23502");
  });

  it("tenantId must be an existing tenant", async () => {
    expect(await codeOf(newPath("no-such-tenant"))).toBe("23503");
  });

  it("createdById must be an existing user when given", async () => {
    const w = await prerequisiteWorld();

    expect(await codeOf(newPath(w.tenant.id, "no-such-user"))).toBe("23503");
  });

  it("deleting the tenant deletes its paths and their course rows, and leaves the courses", async () => {
    const tenant = await createTenant();
    const w = await prerequisiteWorld();
    const path = await newPath(tenant.id);
    await db.learningPathCourse.create({
      data: { pathId: path.id, courseId: w.course.id, position: 1 },
    });

    await db.tenant.delete({ where: { id: tenant.id } });

    expect(await db.learningPath.count({ where: { id: path.id } })).toBe(0);
    expect(await db.learningPathCourse.count({ where: { pathId: path.id } })).toBe(0);
    expect(await db.course.count({ where: { id: w.course.id } })).toBe(1);
  });

  it("deleting the creator keeps the path and clears createdById", async () => {
    const w = await prerequisiteWorld();
    const creator = await db.user.create({
      data: { clerkId: `c-${Math.random()}`, email: `c-${Math.random()}@example.test` },
    });
    const path = await newPath(w.tenant.id, creator.id);

    await db.user.delete({ where: { id: creator.id } });

    expect(await db.learningPath.findUniqueOrThrow({ where: { id: path.id } })).toMatchObject({
      createdById: null,
      tenantId: w.tenant.id,
    });
  });
});

describe("LearningPathCourse — constraints", () => {
  it("the same course cannot be in the same path twice", async () => {
    const w = await prerequisiteWorld();
    const path = await newPath(w.tenant.id);
    await db.learningPathCourse.create({
      data: { pathId: path.id, courseId: w.course.id, position: 1 },
    });

    expect(
      await codeOf(
        db.learningPathCourse.create({
          data: { pathId: path.id, courseId: w.course.id, position: 2 },
        })
      )
    ).toBe("23505");
  });

  it("the same course can be in different paths", async () => {
    const w = await prerequisiteWorld();
    const [p1, p2] = await Promise.all([newPath(w.tenant.id), newPath(w.tenant.id)]);

    await db.learningPathCourse.create({
      data: { pathId: p1.id, courseId: w.course.id, position: 1 },
    });
    await db.learningPathCourse.create({
      data: { pathId: p2.id, courseId: w.course.id, position: 1 },
    });

    expect(await db.learningPathCourse.count({ where: { courseId: w.course.id } })).toBe(2);
  });

  it("the course and the path must exist", async () => {
    const w = await prerequisiteWorld();
    const path = await newPath(w.tenant.id);

    expect(
      await codeOf(
        db.learningPathCourse.create({ data: { pathId: path.id, courseId: "nope", position: 1 } })
      )
    ).toBe("23503");
    expect(
      await codeOf(
        db.learningPathCourse.create({
          data: { pathId: "nope", courseId: w.course.id, position: 1 },
        })
      )
    ).toBe("23503");
  });

  it("positions may repeat at the database level: reorder renumbering needs the freedom", async () => {
    const w = await prerequisiteWorld();
    const [a, b] = await Promise.all([w.make(), w.make()]);
    const path = await newPath(w.tenant.id);

    await db.learningPathCourse.create({ data: { pathId: path.id, courseId: a.id, position: 1 } });
    await db.learningPathCourse.create({ data: { pathId: path.id, courseId: b.id, position: 1 } });

    expect(
      await db.learningPathCourse.findMany({
        where: { pathId: path.id },
        select: { position: true },
      })
    ).toEqual([{ position: 1 }, { position: 1 }]);
  });

  it("position is required", async () => {
    const w = await prerequisiteWorld();
    const path = await newPath(w.tenant.id);
    const code = await codeOf(
      db.$executeRaw`INSERT INTO "LearningPathCourse" ("id","pathId","courseId")
        VALUES (${`m-${Math.random()}`}, ${path.id}, ${w.course.id})`
    );

    expect(code).toBe("23502");
  });

  it("deleting a path deletes its course rows and leaves the courses", async () => {
    const w = await prerequisiteWorld();
    const a = await w.make();
    const path = await newPath(w.tenant.id);
    await db.learningPathCourse.create({ data: { pathId: path.id, courseId: a.id, position: 1 } });

    await db.learningPath.delete({ where: { id: path.id } });

    expect(await db.learningPathCourse.count({ where: { pathId: path.id } })).toBe(0);
    expect(await db.course.count({ where: { id: a.id } })).toBe(1);
  });

  it("deleting a course removes only its own rows, from every path, and leaves the paths", async () => {
    const w = await prerequisiteWorld();
    const [gone, kept] = await Promise.all([w.make(), w.make()]);
    const [p1, p2] = await Promise.all([newPath(w.tenant.id), newPath(w.tenant.id)]);
    for (const p of [p1, p2]) {
      await db.learningPathCourse.create({
        data: { pathId: p.id, courseId: gone.id, position: 1 },
      });
    }
    await db.learningPathCourse.create({ data: { pathId: p1.id, courseId: kept.id, position: 2 } });

    await db.course.delete({ where: { id: gone.id } });

    expect(await db.learningPath.count({ where: { id: { in: [p1.id, p2.id] } } })).toBe(2);
    expect(
      await db.learningPathCourse.findMany({
        where: { pathId: { in: [p1.id, p2.id] } },
        select: { courseId: true },
      })
    ).toEqual([{ courseId: kept.id }]);
  });
});

describe("indexes", () => {
  async function indexes(table: string) {
    return db.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = ${table} ORDER BY indexname`;
  }

  it("LearningPath is indexed by (tenantId, status, createdAt)", async () => {
    const found = await indexes("LearningPath");

    expect(found.map((i) => i.indexname)).toEqual([
      "LearningPath_pkey",
      "LearningPath_tenantId_status_createdAt_idx",
    ]);
    expect(found[1].indexdef).toContain('("tenantId", status, "createdAt")');
    expect(found[1].indexdef).not.toContain("UNIQUE");
  });

  it("LearningPathCourse has the unique (pathId, courseId) and the two lookup indexes, and nothing unique on position", async () => {
    const found = await indexes("LearningPathCourse");
    const byName = Object.fromEntries(found.map((i) => [i.indexname, i.indexdef]));

    expect(Object.keys(byName).sort()).toEqual([
      "LearningPathCourse_courseId_idx",
      "LearningPathCourse_pathId_courseId_key",
      "LearningPathCourse_pathId_position_idx",
      "LearningPathCourse_pkey",
    ]);
    expect(byName.LearningPathCourse_pathId_courseId_key).toContain("UNIQUE");
    expect(byName.LearningPathCourse_pathId_courseId_key).toContain('("pathId", "courseId")');
    expect(byName.LearningPathCourse_pathId_position_idx).toMatch(/\("pathId", "?position"?\)/);
    expect(byName.LearningPathCourse_pathId_position_idx).not.toContain("UNIQUE");
    expect(byName.LearningPathCourse_courseId_idx).toContain('("courseId")');
    expect(
      found.filter((i) => i.indexdef.includes("UNIQUE") && i.indexdef.includes("position"))
    ).toEqual([]);
  });
});
