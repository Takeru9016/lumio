import { db } from "@/lib/db";

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function isYesterday(date: Date, today: Date): boolean {
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  return isSameDay(date, yesterday);
}

export async function updateStreak(userId: string): Promise<void> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { lastActiveDate: true, currentStreak: true, longestStreak: true },
  });
  if (!user) return;

  const today = new Date();

  if (user.lastActiveDate && isSameDay(user.lastActiveDate, today)) return;

  let newStreak: number;
  if (!user.lastActiveDate || !isYesterday(user.lastActiveDate, today)) {
    newStreak = 1;
  } else {
    newStreak = user.currentStreak + 1;
  }

  const newLongest = Math.max(newStreak, user.longestStreak);

  await db.user.update({
    where: { id: userId },
    data: {
      currentStreak: newStreak,
      longestStreak: newLongest,
      lastActiveDate: today,
    },
  });
}
