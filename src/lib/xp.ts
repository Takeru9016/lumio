import { db } from "@/lib/db";

export const XP_EVENTS = {
  LESSON_COMPLETE: 10,
  QUIZ_PASS: 25,
  QUIZ_PERFECT: 50,
  ASSIGNMENT_SUBMIT: 15,
  DAILY_LOGIN: 5,
  COURSE_COMPLETE: 100,
} as const;

export type XPEvent = keyof typeof XP_EVENTS;

export async function awardXP(
  userId: string,
  event: XPEvent,
  amount: number,
): Promise<number> {
  const [updated] = await Promise.all([
    db.user.update({
      where: { id: userId },
      data: { xpTotal: { increment: amount } },
      select: { xpTotal: true },
    }),
    db.xPTransaction.create({
      data: { userId, event, amount },
    }),
  ]);

  return updated.xpTotal;
}
