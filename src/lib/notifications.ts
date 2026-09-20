import type { NotificationType } from "@/generated/prisma/enums";
import { db } from "@/lib/db";

interface CreateNotificationParams {
  userId: string;
  tenantId: string;
  type: NotificationType;
  title: string;
  body: string;
  link?: string;
  // Optional idempotency key, unique per user. The first call with a key
  // creates the notification; any later call with the same key is a no-op.
  dedupeKey?: string;
}

export type CreateNotificationResult = {
  // False only when `dedupeKey` matched an existing notification for the user.
  // A later email layer sends only when this is true.
  created: boolean;
};

// Fire-and-forget by convention at call sites (`.catch(() => {})`) — a failed
// notification insert must never fail the action that triggered it.
//
// Idempotency is decided by the database, never by a read-then-write: the
// insert uses ON CONFLICT DO NOTHING against the (userId, dedupeKey) unique
// index, so concurrent calls with one key produce exactly one row and exactly
// one `created: true`. Notifications without a dedupeKey never conflict.
export async function createNotification(
  params: CreateNotificationParams
): Promise<CreateNotificationResult> {
  const { count } = await db.notification.createMany({
    data: [params],
    skipDuplicates: true,
  });
  return { created: count === 1 };
}
