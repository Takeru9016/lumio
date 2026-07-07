import type { Plan, Role } from "@/generated/prisma/enums";
import { db } from "@/lib/db";

export interface AdminUserListItem {
  id: string;
  name: string | null;
  email: string;
  role: Role;
  plan: Plan;
  tenantName: string | null;
  createdAt: Date;
}

const RESULT_LIMIT = 100;

export async function searchUsers({
  q,
  role,
}: {
  q?: string;
  role?: Role;
}): Promise<AdminUserListItem[]> {
  const trimmed = q?.trim();

  const users = await db.user.findMany({
    where: {
      deletedAt: null,
      role: role ?? undefined,
      ...(trimmed
        ? {
            OR: [
              { name: { contains: trimmed, mode: "insensitive" } },
              { email: { contains: trimmed, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      plan: true,
      createdAt: true,
      tenant: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: RESULT_LIMIT,
  });

  return users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    plan: u.plan,
    tenantName: u.tenant?.name ?? null,
    createdAt: u.createdAt,
  }));
}
