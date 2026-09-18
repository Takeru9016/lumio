import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import { db } from "@/lib/db";
import {
  getOrganizationCapabilityReport,
  OrgCapabilityInvalidRoleError,
} from "@/lib/domain/capability/organizationReport";
import { listJobRoles } from "@/lib/domain/capability/roleManagement";
import { OrgCapabilityClient } from "./OrgCapabilityClient";

interface OrgCapabilityPageProps {
  searchParams: Promise<{ role?: string }>;
}

export default async function OrgCapabilityPage({ searchParams }: OrgCapabilityPageProps) {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true, role: true, tenantId: true },
  });
  if (!dbUser || dbUser.role !== "ORG_ADMIN") redirect("/dashboard");

  if (!dbUser.tenantId) {
    return (
      <OrgCapabilityClient
        initialPage={{ learners: [], nextCursor: null }}
        jobRoles={[]}
        selectedRoleId={null}
      />
    );
  }

  const ctx = { userId: dbUser.id, clerkId: userId, tenantId: dbUser.tenantId, role: dbUser.role };

  // Phase 21: URL search-param role filter — shareable/bookmarkable, survives
  // refresh, matches the same pattern the student capability page uses.
  // `listJobRoles` is the tenant's authoritative role list (Phase 19,
  // ORG_ADMIN-only) — reused directly rather than re-querying JobRole here.
  const { role: requestedRoleId } = await searchParams;
  const jobRoles = await listJobRoles(ctx);
  const roleId =
    requestedRoleId && jobRoles.some((r) => r.id === requestedRoleId) ? requestedRoleId : undefined;

  let initialPage: Awaited<ReturnType<typeof getOrganizationCapabilityReport>>;
  try {
    initialPage = await getOrganizationCapabilityReport(dbUser.tenantId, { roleId });
  } catch (err) {
    // An invalid roleId can only reach here via a stale/tampered URL — the
    // requestedRoleId above is already validated against jobRoles, so this
    // is defense in depth, not the expected path.
    if (err instanceof OrgCapabilityInvalidRoleError) {
      initialPage = { learners: [], nextCursor: null };
    } else {
      throw err;
    }
  }

  return (
    <OrgCapabilityClient
      initialPage={initialPage}
      jobRoles={jobRoles.map((r) => ({ id: r.id, name: r.name }))}
      selectedRoleId={roleId ?? null}
    />
  );
}
