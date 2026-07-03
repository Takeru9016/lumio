import { db } from "@/lib/db";

export async function recordMandatoryTrainingCompletion(
  userId: string,
  courseId: string
): Promise<void> {
  const teamIds = (
    await db.teamMember.findMany({ where: { userId }, select: { teamId: true } })
  ).map((m) => m.teamId);

  if (teamIds.length === 0) return;

  await db.mandatoryTraining.updateMany({
    where: { courseId, teamId: { in: teamIds } },
    data: { completedCount: { increment: 1 } },
  });
}
