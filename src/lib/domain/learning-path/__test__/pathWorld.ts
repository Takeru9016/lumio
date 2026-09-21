import type { AuthContext } from "@/lib/auth/context";
import { db } from "@/lib/db";
import {
  createCourseIn,
  createScenario,
  createUserIn,
} from "@/lib/domain/learning-assignment/__test__/fixtures";

type CourseStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";
type PathStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";

let seq = 0;

/**
 * A tenant with an admin, an instructor who owns every course made here, and a
 * learner, plus the helpers the admin path tests share. Paths and memberships are
 * written straight to the tables: the rules for changing them are what the tests
 * of the domain and the routes exercise, and these fixtures only set the scene.
 */
export async function pathWorld() {
  const s = await createScenario();

  /** A course of this tenant. `lessons: false` leaves it with nothing to complete. */
  const make = async (overrides: { status?: CourseStatus; lessons?: boolean } = {}) => {
    const { course, lesson } = await createCourseIn(s.tenant.id, s.instructor.user.id, {
      status: overrides.status,
    });
    if (overrides.lessons === false) {
      await db.lesson.update({ where: { id: lesson.id }, data: { isPublished: false } });
    }
    return course;
  };

  const makeMany = (count: number) => Promise.all(Array.from({ length: count }, () => make()));

  /** A course with no tenant: the open catalogue. */
  const makeTenantless = async () => (await createCourseIn(null, s.instructor.user.id)).course;

  /** A course of a different tenant. */
  const makeForeign = async (overrides: { status?: CourseStatus } = {}) => {
    const other = await createScenario();
    return (await createCourseIn(other.tenant.id, other.instructor.user.id, overrides)).course;
  };

  const makePath = async (
    options: {
      status?: PathStatus;
      title?: string;
      courses?: { id: string }[];
      tenantId?: string;
      createdAt?: Date;
    } = {}
  ) => {
    seq += 1;
    const path = await db.learningPath.create({
      data: {
        tenantId: options.tenantId ?? s.tenant.id,
        createdById: s.admin.user.id,
        title: options.title ?? `Path ${seq}`,
        status: options.status ?? "DRAFT",
        ...(options.status === "PUBLISHED" ? { publishedAt: new Date() } : {}),
        ...(options.createdAt ? { createdAt: options.createdAt } : {}),
      },
    });
    for (const [index, course] of (options.courses ?? []).entries()) {
      await db.learningPathCourse.create({
        data: { pathId: path.id, courseId: course.id, position: index + 1 },
      });
    }
    return path;
  };

  const members = (pathId: string) =>
    db.learningPathCourse.findMany({
      where: { pathId },
      orderBy: [{ position: "asc" }, { courseId: "asc" }],
      select: { courseId: true, position: true },
    });

  const memberIds = async (pathId: string) => (await members(pathId)).map((m) => m.courseId);

  const archive = (courseId: string) =>
    db.course.update({ where: { id: courseId }, data: { status: "ARCHIVED" } });

  /** Everything a path operation must leave alone, as counts. */
  const sideEffects = async () => ({
    enrollments: await db.enrollment.count(),
    assignments: await db.learningAssignment.count(),
    notifications: await db.notification.count(),
    events: await db.learningEvent.count(),
    evidence: await db.skillEvidence.count(),
    prerequisites: await db.coursePrerequisite.count(),
    courses: await db.course.count(),
    lessons: await db.lesson.count(),
  });

  const superAdmin = await createUserIn(s.tenant.id, "SUPER_ADMIN");
  const tenantlessAdmin = await db.user.create({
    data: {
      clerkId: `clerk-tenantless-${Date.now()}-${seq}`,
      email: `tenantless-${Date.now()}-${seq}@example.test`,
      role: "ORG_ADMIN",
    },
  });
  const tenantlessCtx: AuthContext = {
    userId: tenantlessAdmin.id,
    clerkId: tenantlessAdmin.clerkId,
    tenantId: null,
    role: "ORG_ADMIN",
  };

  /** Everyone who must be refused, with the context a route would build for them. */
  const outsiders: [string, AuthContext][] = [
    ["STUDENT", s.learner.ctx],
    ["INSTRUCTOR", s.instructor.ctx],
    ["SUPER_ADMIN", superAdmin.ctx],
    ["tenantless ORG_ADMIN", tenantlessCtx],
  ];

  return {
    ...s,
    superAdmin,
    tenantlessAdmin,
    tenantlessCtx,
    outsiders,
    make,
    makeMany,
    makeTenantless,
    makeForeign,
    makePath,
    members,
    memberIds,
    archive,
    sideEffects,
  };
}

export type PathWorld = Awaited<ReturnType<typeof pathWorld>>;

/** The code of the LearningPathError a call fails with, or null when it does not. */
export async function errorCodeOf(call: () => Promise<unknown>): Promise<string | null> {
  try {
    await call();
    return null;
  } catch (err) {
    return typeof err === "object" && err !== null && "code" in err
      ? String((err as { code: unknown }).code)
      : `UNEXPECTED:${String(err)}`;
  }
}
