import type { AuthContext } from "@/lib/auth/context";
import { db } from "@/lib/db";

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

type TestRole = "STUDENT" | "ORG_ADMIN" | "INSTRUCTOR" | "SUPER_ADMIN";

export type TenantUser = {
  user: Awaited<ReturnType<typeof db.user.create>>;
  ctx: AuthContext & { tenantId: string };
};

export async function createTenant() {
  return db.tenant.create({ data: { name: unique("tenant"), slug: unique("tenant-slug") } });
}

export async function createUserIn(
  tenantId: string,
  role: TestRole = "STUDENT"
): Promise<TenantUser> {
  const user = await db.user.create({
    data: {
      clerkId: unique("clerk"),
      email: `${unique("user")}@example.test`,
      name: unique("name"),
      tenantId,
      role,
    },
  });
  return { user, ctx: { userId: user.id, clerkId: user.clerkId, tenantId, role } };
}

/** A user with no tenant — e.g. a FREE-plan solo learner. */
export async function createTenantlessStudent() {
  return db.user.create({
    data: {
      clerkId: unique("clerk"),
      email: `${unique("user")}@example.test`,
      role: "STUDENT",
    },
  });
}

export async function createCourseIn(
  tenantId: string | null,
  instructorId: string,
  overrides: { status?: "DRAFT" | "PUBLISHED" | "ARCHIVED"; price?: number } = {}
) {
  const course = await db.course.create({
    data: {
      title: unique("course"),
      slug: unique("course-slug"),
      instructorId,
      tenantId,
      status: overrides.status ?? "PUBLISHED",
      price: overrides.price ?? 0,
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
      isPublished: true,
      sectionId: section.id,
    },
  });
  return { course, lesson };
}

/** One tenant with an ORG_ADMIN, an INSTRUCTOR, a STUDENT and a published free course. */
export async function createScenario() {
  const tenant = await createTenant();
  const admin = await createUserIn(tenant.id, "ORG_ADMIN");
  const instructor = await createUserIn(tenant.id, "INSTRUCTOR");
  const learner = await createUserIn(tenant.id, "STUDENT");
  const { course, lesson } = await createCourseIn(tenant.id, instructor.user.id);
  return { tenant, admin, instructor, learner, course, lesson };
}

export async function createTeamWithMember(tenantId: string, userId: string | null) {
  const team = await db.team.create({ data: { name: unique("team"), tenantId } });
  if (userId) await db.teamMember.create({ data: { teamId: team.id, userId } });
  return team;
}

export async function createMandatoryTraining(params: {
  tenantId: string;
  courseId: string;
  teamId: string;
  dueDate?: Date;
}) {
  return db.mandatoryTraining.create({
    data: {
      tenantId: params.tenantId,
      courseId: params.courseId,
      teamId: params.teamId,
      dueDate: params.dueDate ?? new Date("2027-01-15T23:59:59.999Z"),
    },
  });
}

export async function createRoleWithSkill(params: {
  tenantId: string;
  requiredProficiency?: "BEGINNER" | "INTERMEDIATE" | "ADVANCED" | "EXPERT";
  skillStatus?: "ACTIVE" | "ARCHIVED";
}) {
  const role = await db.jobRole.create({
    data: { tenantId: params.tenantId, name: unique("role"), slug: unique("role-slug") },
  });
  const skill = await db.skill.create({
    data: {
      tenantId: params.tenantId,
      name: unique("skill"),
      slug: unique("skill-slug"),
      status: params.skillStatus ?? "ACTIVE",
    },
  });
  await db.roleSkill.create({
    data: {
      roleId: role.id,
      skillId: skill.id,
      requiredProficiency: params.requiredProficiency ?? "INTERMEDIATE",
    },
  });
  return { role, skill };
}

export async function addSkillToRole(
  roleId: string,
  tenantId: string,
  requiredProficiency: "BEGINNER" | "INTERMEDIATE" | "ADVANCED" | "EXPERT" = "INTERMEDIATE"
) {
  const skill = await db.skill.create({
    data: { tenantId, name: unique("skill"), slug: unique("skill-slug") },
  });
  await db.roleSkill.create({ data: { roleId, skillId: skill.id, requiredProficiency } });
  return skill;
}

export async function assignRole(tenantId: string, userId: string, roleId: string) {
  return db.userJobRole.create({ data: { tenantId, userId, roleId, isPrimary: true } });
}

export async function setUserSkill(
  tenantId: string,
  userId: string,
  skillId: string,
  proficiency: "NONE" | "BEGINNER" | "INTERMEDIATE" | "ADVANCED" | "EXPERT"
) {
  return db.userSkill.create({ data: { tenantId, userId, skillId, proficiency } });
}

export async function mapCourseToSkill(courseId: string, skillId: string) {
  return db.courseSkill.create({ data: { courseId, skillId } });
}
