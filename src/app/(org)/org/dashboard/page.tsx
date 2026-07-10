import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import { redirect } from "next/navigation";

import { SendNudgeButton } from "@/components";
import { db } from "@/lib/db";
import { getOrgDashboardData } from "@/lib/org-dashboard";

export default async function OrgDashboardPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { role: true, tenantId: true },
  });
  if (!dbUser || dbUser.role !== "ORG_ADMIN") redirect("/dashboard");
  if (!dbUser.tenantId) redirect("/onboarding");

  const data = await getOrgDashboardData(dbUser.tenantId);
  const mostUrgentTraining = data.overdueTrainings[0];
  const seatUsagePct = Math.min(
    Math.round((data.activeMembers / Math.max(data.tenant.seatLimit, 1)) * 100),
    100
  );
  const isNearSeatLimit = seatUsagePct >= 80;

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
      <div>
        <h1 className="text-xl font-semibold font-heading text-text-primary">{data.tenant.name}</h1>
        <p className="text-sm text-text-muted mt-1">Organization overview</p>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-border rounded-lg p-4 shadow-sm">
          <p className="text-xs font-medium text-text-muted mb-2">Active members</p>
          <p className="text-2xl font-bold text-text-primary font-heading">{data.activeMembers}</p>
        </div>
        <div className="bg-white border border-border rounded-lg p-4 shadow-sm">
          <p className="text-xs font-medium text-text-muted mb-2">Completion rate</p>
          <p className="text-2xl font-bold text-text-primary font-heading">
            {data.completionRate}%
          </p>
          {data.completionRateDelta !== 0 && (
            <p
              className={`text-xs mt-1 font-medium ${
                data.completionRateDelta > 0 ? "text-success" : "text-danger"
              }`}
            >
              {data.completionRateDelta > 0 ? "+" : ""}
              {data.completionRateDelta} completions vs. prior 30 days
            </p>
          )}
        </div>
        <div className="bg-white border border-border rounded-lg p-4 shadow-sm">
          <p className="text-xs font-medium text-text-muted mb-2">Overdue training</p>
          <p
            className={`text-2xl font-bold font-heading ${
              data.overdueTrainings.length > 0 ? "text-danger" : "text-text-primary"
            }`}
          >
            {data.overdueTrainings.length}
          </p>
        </div>
        <div className="bg-white border border-border rounded-lg p-4 shadow-sm">
          <p className="text-xs font-medium text-text-muted mb-2">Certs issued (30d)</p>
          <p className="text-2xl font-bold text-text-primary font-heading">
            {data.certsIssuedLast30Days}
          </p>
        </div>
      </div>

      {/* Overdue training alert */}
      {mostUrgentTraining && (
        <div className="bg-warning-bg border border-[var(--color-warning)]/30 rounded-lg p-4 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-warning">
              {mostUrgentTraining.remainingCount} member
              {mostUrgentTraining.remainingCount === 1 ? "" : "s"} haven&apos;t completed{" "}
              {mostUrgentTraining.courseTitle}
            </p>
            <p className="text-xs text-text-muted mt-0.5">
              {mostUrgentTraining.teamName} — was due{" "}
              {mostUrgentTraining.dueDate.toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </p>
          </div>
          <SendNudgeButton trainingId={mostUrgentTraining.id} />
        </div>
      )}

      {/* AI Skills Gap — feature is still a "coming soon" placeholder in Reports,
          so this must not claim it's ready (see reports/page.tsx skills-gap tab). */}
      <Link
        href="/reports"
        className="block bg-(--color-ai-bg) border border-(--color-ai-border) rounded-lg p-4
                   flex items-center gap-3 hover:opacity-90 transition-opacity"
      >
        <span className="text-xl">✦</span>
        <div>
          <p className="text-sm font-semibold text-(--color-ai)">
            AI skills gap analysis — coming soon
          </p>
          <p className="text-xs text-text-muted">Preview what's coming in Reports</p>
        </div>
      </Link>

      {/* Per-team / per-course completion breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white border border-border rounded-lg overflow-hidden shadow-sm">
          <div className="px-4 py-3 border-b border-border">
            <p className="text-sm font-semibold text-text-primary">Completion by team</p>
          </div>
          {data.teamBreakdown.length === 0 ? (
            <p className="px-4 py-6 text-sm text-text-muted text-center">No teams yet.</p>
          ) : (
            <div className="divide-y divide-border">
              {data.teamBreakdown.map((team) => (
                <div
                  key={team.teamId}
                  className="flex items-center justify-between gap-4 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text-primary truncate">
                      {team.teamName}
                    </p>
                    <p className="text-xs text-text-muted">{team.memberCount} members</p>
                  </div>
                  <span className="text-sm font-semibold text-text-primary shrink-0">
                    {team.completionRate}%
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white border border-border rounded-lg overflow-hidden shadow-sm">
          <div className="px-4 py-3 border-b border-border">
            <p className="text-sm font-semibold text-text-primary">Completion by course</p>
          </div>
          {data.courseBreakdown.length === 0 ? (
            <p className="px-4 py-6 text-sm text-text-muted text-center">No enrollments yet.</p>
          ) : (
            <div className="divide-y divide-border">
              {data.courseBreakdown.map((course) => (
                <div
                  key={course.courseId}
                  className="flex items-center justify-between gap-4 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text-primary truncate">
                      {course.courseTitle}
                    </p>
                    <p className="text-xs text-text-muted">{course.enrollmentCount} enrolled</p>
                  </div>
                  <span className="text-sm font-semibold text-text-primary shrink-0">
                    {course.completionRate}%
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* At-risk members */}
      <div className="bg-white border border-border rounded-lg overflow-hidden shadow-sm">
        <div className="px-4 py-3 border-b border-border">
          <p className="text-sm font-semibold text-text-primary">At-risk members</p>
          <p className="text-xs text-text-muted mt-0.5">
            Enrolled but inactive for 14+ days on their oldest active course
          </p>
        </div>
        {data.atRiskMembers.length === 0 ? (
          <p className="px-4 py-6 text-sm text-text-muted text-center">
            No one is currently falling behind.
          </p>
        ) : (
          <div className="divide-y divide-border">
            {data.atRiskMembers.map((member) => (
              <div
                key={member.userId}
                className="flex items-center justify-between gap-4 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-text-primary truncate">
                    {member.name ?? member.email}
                  </p>
                  <p className="text-xs text-text-muted truncate">{member.courseTitle}</p>
                </div>
                <span className="text-xs text-danger shrink-0">
                  {member.daysSinceActive != null
                    ? `${member.daysSinceActive}d inactive`
                    : "Never active"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Seat usage */}
      <div className="bg-white border border-border rounded-lg p-4 shadow-sm">
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-semibold text-text-primary">Seat usage</p>
          <p className="text-xs text-text-muted">
            {data.activeMembers} of {data.tenant.seatLimit} seats used
          </p>
        </div>
        <div className="h-1.5 rounded-full bg-surface-3">
          <div
            className={`h-full rounded-full transition-all ${
              isNearSeatLimit ? "bg-(--color-warning)" : "bg-(--color-brand)"
            }`}
            style={{ width: `${seatUsagePct}%` }}
          />
        </div>
        {isNearSeatLimit && (
          <Link
            href="/org/settings"
            className="inline-block mt-2 text-xs font-medium text-(--color-brand) hover:opacity-70 transition-opacity"
          >
            Add seats →
          </Link>
        )}
      </div>
    </div>
  );
}
