import { db } from "@/lib/db";

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

/** A user in an EXISTING tenant (createTenantUser always creates a new tenant). */
export function createUserInTenant(
  tenantId: string,
  role: "STUDENT" | "INSTRUCTOR" | "ORG_ADMIN" | "SUPER_ADMIN"
) {
  return db.user.create({
    data: {
      clerkId: unique("clerk"),
      email: `${unique("user")}@example.test`,
      tenantId,
      role,
    },
  });
}

/** A tenant-less user (FREE-plan / solo). */
export function createSoloUser(role: "STUDENT" | "INSTRUCTOR") {
  return db.user.create({
    data: { clerkId: unique("clerk"), email: `${unique("user")}@example.test`, role },
  });
}

export function addSection(courseId: string, order = 5) {
  return db.section.create({ data: { title: unique("section"), order, courseId } });
}

export function addLesson(sectionId: string, order = 5) {
  return db.lesson.create({
    data: {
      title: unique("lesson"),
      slug: unique("lesson-slug"),
      type: "TEXT",
      order,
      isPublished: true,
      sectionId,
      textContent: "secret lesson body",
    },
  });
}
