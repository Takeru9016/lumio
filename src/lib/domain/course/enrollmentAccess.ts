/**
 * Whether a learner may enroll in (or buy) a course, by tenant alone.
 *
 * A course that belongs to a tenant is open only to members of that tenant. A
 * course with no tenant is the open catalogue and stays enrollable by anyone.
 * Enrollment is what grants a learner lesson access and AI summaries, so this
 * is the boundary those entitlements rely on: a learner with no tenant, or in a
 * different tenant, must never obtain an enrollment in a tenant-owned course.
 *
 * Publication, role and payment rules are separate and unchanged.
 */
export function canEnrollInCourse(
  courseTenantId: string | null,
  userTenantId: string | null
): boolean {
  return courseTenantId === null || courseTenantId === userTenantId;
}
