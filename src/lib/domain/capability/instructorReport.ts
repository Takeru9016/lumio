import type { SkillProficiency } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { isAtLeast } from "@/lib/domain/capability/proficiencyOrder";

export type InstructorCapabilitySkillRow = {
  skillId: string;
  skillName: string;
  required: SkillProficiency;
  current: SkillProficiency;
  met: boolean;
};

export type InstructorCapabilityLearnerRow = {
  userId: string;
  name: string;
  roleId: string;
  roleName: string;
  skills: InstructorCapabilitySkillRow[];
};

export type InstructorCapabilityPage = {
  learners: InstructorCapabilityLearnerRow[];
  nextCursor: string | null;
};

type Cursor = { name: string | null; email: string; id: string };

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export class InstructorCapabilityCursorError extends Error {
  constructor() {
    super("Invalid cursor");
    this.name = "InstructorCapabilityCursorError";
  }
}

// Self-contained, deliberately not imported from organizationReport.ts — that
// module is Phase 9's, untouched by this phase; duplicating this small,
// pure encode/decode pair keeps the two aggregate reports decoupled rather
// than introducing a shared abstraction across two different authorization
// scopes (see instructorReport.test.ts's architecture test).
function encodeCursor(row: Cursor): string {
  return Buffer.from(JSON.stringify(row), "utf8").toString("base64");
}

function decodeCursor(raw: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (typeof parsed.name !== "string" && parsed.name !== null) ||
      typeof parsed.email !== "string" ||
      typeof parsed.id !== "string"
    ) {
      throw new Error("malformed cursor payload");
    }
    return { name: parsed.name, email: parsed.email, id: parsed.id };
  } catch {
    throw new InstructorCapabilityCursorError();
  }
}

/**
 * Instructor-scoped capability aggregate (Phase 11 locked contract).
 *
 * Population: students with at least one Enrollment in a Course owned by
 * `instructorId` — the same ownership relationship getInstructorStudents()
 * already uses (Enrollment -> Course.instructorId), reproduced here rather
 * than reused, since that function returns a differently-shaped progress/
 * quiz-average row, not a capability projection, and coupling the two would
 * tie an unrelated read model's shape to this one's security boundary.
 * `Course.tenantId = tenantId` is enforced as an explicit defense-in-depth
 * predicate alongside `instructorId` — never trust ownership alone to imply
 * tenant scope, matching this codebase's existing "sibling-FK tenant
 * consistency is application-level only" posture.
 *
 * Takes the authenticated instructorId + tenantId only — never a role, never
 * a caller-supplied student/tenant id. Authorization (is the caller an
 * INSTRUCTOR) is strictly the route's responsibility, exactly as
 * getOrganizationCapabilityReport(tenantId, ...) already establishes for
 * ORG_ADMIN.
 *
 * Batched, fixed query count regardless of student population size:
 *
 *   Query 1 — distinct enrolled-student ids for this instructor's own,
 *             tenant-matching courses
 *   Query 2 — keyset-paginated User page over that id set (name asc, email
 *             asc, id asc) — a student enrolled in multiple of this
 *             instructor's courses appears exactly once, since Query 1 is
 *             already distinct and Query 2 selects by primary key
 *   Query 3 — primary UserJobRole rows for that page's users, earliest
 *             assignedAt per user resolved in memory (same tie-break rule
 *             as gaps.ts's resolvePrimaryRoleId(), reproduced here — not
 *             called in a loop, which would be the exact N+1 this contract
 *             forbids)
 *   Query 4 — RoleSkill (+ JobRole names) for the page's distinct roles
 *   Query 5 — UserSkill for the page's users
 *
 * Never selects/queries SkillEvidence or any evidence-adjacent field —
 * structurally incapable of leaking it, not merely filtered in the UI.
 */
export async function getInstructorCapabilityReport(
  instructorId: string,
  tenantId: string,
  options?: { cursor?: string; limit?: number }
): Promise<InstructorCapabilityPage> {
  const limit = Math.min(options?.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const cursor = options?.cursor ? decodeCursor(options.cursor) : null;

  const ownedEnrollments = await db.enrollment.findMany({
    where: { course: { instructorId, tenantId } },
    select: { userId: true },
    distinct: ["userId"],
  });
  const studentIds = ownedEnrollments.map((e) => e.userId);

  if (studentIds.length === 0) {
    return { learners: [], nextCursor: null };
  }

  // Postgres ASC places NULL name last by default — mirrored here by
  // treating a null cursor.name as "greater than every non-null name" so
  // the keyset condition below resumes correctly past the null-name tail.
  const users = await db.user.findMany({
    where: {
      id: { in: studentIds },
      tenantId,
      deletedAt: null,
      ...(cursor
        ? {
            OR:
              cursor.name === null
                ? [
                    { name: null, email: { gt: cursor.email } },
                    { name: null, email: cursor.email, id: { gt: cursor.id } },
                  ]
                : [
                    { name: { gt: cursor.name } },
                    { name: null },
                    { name: cursor.name, email: { gt: cursor.email } },
                    { name: cursor.name, email: cursor.email, id: { gt: cursor.id } },
                  ],
          }
        : {}),
    },
    select: { id: true, name: true, email: true },
    orderBy: [{ name: "asc" }, { email: "asc" }, { id: "asc" }],
    take: limit + 1,
  });

  const hasNextPage = users.length > limit;
  const pageUsers = hasNextPage ? users.slice(0, limit) : users;
  const nextCursor = hasNextPage
    ? encodeCursor({
        name: pageUsers[pageUsers.length - 1].name,
        email: pageUsers[pageUsers.length - 1].email,
        id: pageUsers[pageUsers.length - 1].id,
      })
    : null;

  if (pageUsers.length === 0) {
    return { learners: [], nextCursor: null };
  }

  const pageUserIds = pageUsers.map((u) => u.id);

  const primaryRows = await db.userJobRole.findMany({
    where: { tenantId, userId: { in: pageUserIds }, isPrimary: true },
    select: { userId: true, roleId: true, assignedAt: true },
    orderBy: [{ userId: "asc" }, { assignedAt: "asc" }],
  });

  // Earliest assignedAt per user wins — identical tie-break to
  // gaps.ts's resolvePrimaryRoleId(), reproduced across the whole page in
  // one pass rather than calling that self-scoped function once per user.
  const resolvedRoleIdByUser = new Map<string, string>();
  for (const row of primaryRows) {
    if (!resolvedRoleIdByUser.has(row.userId)) {
      resolvedRoleIdByUser.set(row.userId, row.roleId);
    }
  }

  const distinctRoleIds = [...new Set(resolvedRoleIdByUser.values())];

  const [roleSkillRows, roles] = await Promise.all([
    distinctRoleIds.length > 0
      ? db.roleSkill.findMany({
          where: { roleId: { in: distinctRoleIds }, isRequired: true, skill: { status: "ACTIVE" } },
          select: {
            roleId: true,
            requiredProficiency: true,
            skill: { select: { id: true, name: true } },
          },
        })
      : Promise.resolve([]),
    distinctRoleIds.length > 0
      ? db.jobRole.findMany({
          where: { id: { in: distinctRoleIds } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
  ]);

  const roleNameById = new Map(roles.map((r) => [r.id, r.name]));
  const requirementsByRole = new Map<
    string,
    Array<{ skillId: string; skillName: string; required: SkillProficiency }>
  >();
  for (const rs of roleSkillRows) {
    const existing = requirementsByRole.get(rs.roleId);
    const entry = {
      skillId: rs.skill.id,
      skillName: rs.skill.name,
      required: rs.requiredProficiency,
    };
    if (existing) existing.push(entry);
    else requirementsByRole.set(rs.roleId, [entry]);
  }

  const userSkillRows = await db.userSkill.findMany({
    where: { tenantId, userId: { in: pageUserIds } },
    select: { userId: true, skillId: true, proficiency: true },
  });
  const currentByUserAndSkill = new Map<string, SkillProficiency>();
  for (const row of userSkillRows) {
    currentByUserAndSkill.set(`${row.userId}:${row.skillId}`, row.proficiency);
  }

  const learners: InstructorCapabilityLearnerRow[] = [];
  for (const user of pageUsers) {
    const roleId = resolvedRoleIdByUser.get(user.id);
    if (!roleId) continue; // no primary role — excluded (locked contract §7)

    const requirements = requirementsByRole.get(roleId) ?? [];
    const skills: InstructorCapabilitySkillRow[] = requirements.map((req) => {
      const current = currentByUserAndSkill.get(`${user.id}:${req.skillId}`) ?? "NONE";
      return {
        skillId: req.skillId,
        skillName: req.skillName,
        required: req.required,
        current,
        met: isAtLeast(current, req.required),
      };
    });

    learners.push({
      userId: user.id,
      name: user.name ?? user.email,
      roleId,
      roleName: roleNameById.get(roleId) ?? "",
      skills,
    });
  }

  return { learners, nextCursor };
}
