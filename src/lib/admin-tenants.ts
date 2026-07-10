import { db } from "@/lib/db";

export interface TenantListItem {
  id: string;
  name: string;
  slug: string;
  plan: string;
  seatLimit: number;
  memberCount: number;
  suspendedAt: Date | null;
  createdAt: Date;
}

export async function getAllTenants(): Promise<TenantListItem[]> {
  const tenants = await db.tenant.findMany({
    select: {
      id: true,
      name: true,
      slug: true,
      plan: true,
      seatLimit: true,
      suspendedAt: true,
      createdAt: true,
      _count: { select: { users: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return tenants.map((t) => ({
    id: t.id,
    name: t.name,
    slug: t.slug,
    plan: t.plan,
    seatLimit: t.seatLimit,
    // `Tenant.seatCount` is never written anywhere in this codebase — the real
    // member count (`_count.users`) is used instead.
    memberCount: t._count.users,
    suspendedAt: t.suspendedAt,
    createdAt: t.createdAt,
  }));
}
