import type { NotificationType } from "@/generated/prisma/enums";
import { db } from "@/lib/db";

interface CreateNotificationParams {
  userId: string;
  tenantId: string;
  type: NotificationType;
  title: string;
  body: string;
  link?: string;
}

// Fire-and-forget by convention at call sites (`.catch(() => {})`) — a failed
// notification insert must never fail the action that triggered it.
export async function createNotification(params: CreateNotificationParams): Promise<void> {
  await db.notification.create({ data: params });
}
