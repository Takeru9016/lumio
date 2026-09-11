import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import { db } from "@/lib/db";
import { getSkillEvidenceForUser } from "@/lib/domain/capability/evidence";
import { computeCapabilityGap, getUserSkillState } from "@/lib/domain/capability/gaps";
import { CapabilityClient, type RequiredSkillRow } from "./CapabilityClient";

export default async function CapabilityPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true, tenantId: true, role: true },
  });
  if (!dbUser) redirect("/onboarding");

  // Tenant-gated like every other V2 capability read (Phase 5/6) — a
  // FREE-plan user with no tenant has no JobRole/UserSkill state at all.
  // Rendered as an honest empty state, not a redirect — this is a direct
  // nav destination, not a best-effort dashboard widget.
  if (!dbUser.tenantId) {
    return <CapabilityClient state="no-tenant" roleName={null} skills={[]} />;
  }

  const ctx = {
    userId: dbUser.id,
    clerkId: userId,
    tenantId: dbUser.tenantId,
    role: dbUser.role,
  };

  let gapResult: Awaited<ReturnType<typeof computeCapabilityGap>>;
  let userSkills: Awaited<ReturnType<typeof getUserSkillState>>;
  let evidence: Awaited<ReturnType<typeof getSkillEvidenceForUser>>;
  try {
    [gapResult, userSkills, evidence] = await Promise.all([
      computeCapabilityGap(ctx),
      getUserSkillState(ctx),
      getSkillEvidenceForUser(ctx),
    ]);
  } catch {
    // Never expose internal/database errors to the learner — an honest
    // "couldn't load" state instead, matching every other best-effort
    // capability read in this app (Phase 6 dashboard card precedent).
    return <CapabilityClient state="load-failed" roleName={null} skills={[]} />;
  }

  if (!gapResult.role) {
    return <CapabilityClient state="no-role" roleName={null} skills={[]} />;
  }

  const lastAssessedBySkill = new Map(userSkills.map((s) => [s.skillId, s.lastAssessedAt]));
  const evidenceBySkill = new Map<string, typeof evidence>();
  for (const item of evidence) {
    const existing = evidenceBySkill.get(item.skillId);
    if (existing) {
      existing.push(item);
    } else {
      evidenceBySkill.set(item.skillId, [item]);
    }
  }

  // computeCapabilityGap already returns every RoleSkill requirement (met
  // and unmet alike) — the complete required-skill set, not just gaps. No
  // separate "all required skills" computation is reimplemented here.
  const skills: RequiredSkillRow[] = gapResult.gaps.map((gap) => ({
    skillId: gap.skillId,
    skillName: gap.skillName,
    currentProficiency: gap.currentProficiency,
    requiredProficiency: gap.requiredProficiency,
    met: gap.met,
    lastAssessedAt: lastAssessedBySkill.get(gap.skillId)?.toISOString() ?? null,
    evidence: (evidenceBySkill.get(gap.skillId) ?? []).map((item) => ({
      id: item.id,
      type: item.type,
      score: item.score,
      verificationStatus: item.verificationStatus,
      createdAt: item.createdAt.toISOString(),
    })),
  }));

  return <CapabilityClient state="ready" roleName={gapResult.role.name} skills={skills} />;
}
