import type { EvidenceType, EvidenceVerificationStatus } from "@/generated/prisma/client";
import type { AuthContext } from "@/lib/auth/context";
import { db } from "@/lib/db";

type Ctx = AuthContext & { tenantId: string };

export type SkillEvidenceView = {
  id: string;
  skillId: string;
  skillName: string;
  type: EvidenceType;
  score: number | null;
  verificationStatus: EvidenceVerificationStatus;
  createdAt: Date;
};

/**
 * The caller's own SkillEvidence, self-scoped by construction — tenantId
 * and userId come only from ctx, never from a parameter, mirroring
 * computeCapabilityGap/getRecommendedLearning's existing self-scoping
 * (Phase 7 locked contract). Ordering is deterministic: createdAt DESC
 * (newest first), id ASC as the tie-break for identical timestamps — no
 * incidental DB order, no business-ranking concept.
 */
export async function getSkillEvidenceForUser(ctx: Ctx): Promise<SkillEvidenceView[]> {
  const rows = await db.skillEvidence.findMany({
    where: { tenantId: ctx.tenantId, userId: ctx.userId },
    select: {
      id: true,
      skillId: true,
      type: true,
      score: true,
      verificationStatus: true,
      createdAt: true,
      skill: { select: { name: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
  });

  return rows.map((row) => ({
    id: row.id,
    skillId: row.skillId,
    skillName: row.skill.name,
    type: row.type,
    score: row.score,
    verificationStatus: row.verificationStatus,
    createdAt: row.createdAt,
  }));
}
