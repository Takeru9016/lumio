import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import { db } from "@/lib/db";
import { getSkillEvidenceForUser } from "@/lib/domain/capability/evidence";
import {
  computeCapabilityGap,
  getUserAssignedRoles,
  getUserSkillState,
} from "@/lib/domain/capability/gaps";
import { getRecommendedLearning } from "@/lib/domain/capability/recommendations";
import { CapabilityClient, type RequiredSkillRow } from "./CapabilityClient";

interface CapabilityPageProps {
  searchParams: Promise<{ role?: string }>;
}

export default async function CapabilityPage({ searchParams }: CapabilityPageProps) {
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
    return (
      <CapabilityClient
        state="no-tenant"
        roleName={null}
        skills={[]}
        assignedRoles={[]}
        selectedRoleId={null}
        recommendations={[]}
      />
    );
  }

  const ctx = {
    userId: dbUser.id,
    clerkId: userId,
    tenantId: dbUser.tenantId,
    role: dbUser.role,
  };

  // Phase 21: URL search-param role selection — shareable/bookmarkable,
  // survives refresh, and lets this Server Component derive the role
  // context directly without any client-side role-fetch round trip.
  // `requestedRoleId` is validated against the caller's own assigned roles
  // below (getUserAssignedRoles) before it's ever passed into
  // computeCapabilityGap — an unheld/stale roleId is never silently trusted.
  const { role: requestedRoleId } = await searchParams;

  let assignedRoles: Awaited<ReturnType<typeof getUserAssignedRoles>>;
  let gapResult: Awaited<ReturnType<typeof computeCapabilityGap>>;
  let userSkills: Awaited<ReturnType<typeof getUserSkillState>>;
  let evidence: Awaited<ReturnType<typeof getSkillEvidenceForUser>>;
  let recommended: Awaited<ReturnType<typeof getRecommendedLearning>>;
  try {
    assignedRoles = await getUserAssignedRoles(ctx);
    const effectiveRoleId =
      requestedRoleId && assignedRoles.some((r) => r.roleId === requestedRoleId)
        ? requestedRoleId
        : undefined;

    [gapResult, userSkills, evidence, recommended] = await Promise.all([
      computeCapabilityGap(ctx, effectiveRoleId),
      getUserSkillState(ctx),
      getSkillEvidenceForUser(ctx),
      getRecommendedLearning(ctx, effectiveRoleId),
    ]);
  } catch {
    // Never expose internal/database errors to the learner — an honest
    // "couldn't load" state instead, matching every other best-effort
    // capability read in this app (Phase 6 dashboard card precedent).
    return (
      <CapabilityClient
        state="load-failed"
        roleName={null}
        skills={[]}
        assignedRoles={[]}
        selectedRoleId={null}
        recommendations={[]}
      />
    );
  }

  if (!gapResult.role) {
    return (
      <CapabilityClient
        state="no-role"
        roleName={null}
        skills={[]}
        assignedRoles={[]}
        selectedRoleId={null}
        recommendations={[]}
      />
    );
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

  return (
    <CapabilityClient
      state="ready"
      roleName={gapResult.role.name}
      skills={skills}
      assignedRoles={assignedRoles}
      // The ACTUALLY resolved role, not the raw searchParam — a stale/unheld
      // requestedRoleId silently falls through to primary above, and the
      // selector must reflect that real outcome rather than the URL's
      // (possibly wrong) claim, so the fallback is visible, not silent.
      selectedRoleId={gapResult.role.id}
      recommendations={recommended.recommendations}
    />
  );
}
