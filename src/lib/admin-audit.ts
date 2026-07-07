import { db } from "@/lib/db";

export type AdminAction =
  | "TENANT_SUSPENDED"
  | "TENANT_REACTIVATED"
  | "USER_ROLE_CHANGED"
  | "USER_PLAN_CHANGED";

export async function logAdminAction(
  actorId: string,
  action: AdminAction,
  targetType: "Tenant" | "User",
  targetId: string,
  metadata?: Record<string, string | number | boolean | null>
): Promise<void> {
  await db.adminAuditLog.create({
    data: { actorId, action, targetType, targetId, metadata },
  });
}
