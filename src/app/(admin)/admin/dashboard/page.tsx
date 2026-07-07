import { BookOpen, Building2, GraduationCap, Users } from "lucide-react";

import { EnrollmentChart, StatCard } from "@/components";
import { getPlatformDashboardData } from "@/lib/admin-dashboard";

export default async function AdminDashboardPage() {
  const data = await getPlatformDashboardData();

  const totalUsers = data.usersByRole.reduce((sum, r) => sum + r.count, 0);
  const publishedCourses = data.coursesByStatus.find((c) => c.status === "PUBLISHED")?.count ?? 0;

  return (
    <div className="mx-auto max-w-6xl space-y-8 p-6">
      <div>
        <h1
          className="text-xl font-semibold text-text-primary"
          style={{ fontFamily: "var(--font-heading)" }}
        >
          Platform overview
        </h1>
        <p className="text-sm text-text-muted">Lumio-wide stats across every organization.</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Organizations" value={data.totalTenants} icon={Building2} />
        <StatCard label="Users" value={totalUsers} icon={Users} />
        <StatCard label="Published courses" value={publishedCourses} icon={BookOpen} />
        <StatCard label="Total enrollments" value={data.totalEnrollments} icon={GraduationCap} />
      </div>

      {data.suspendedTenants > 0 && (
        <div className="rounded-lg border border-danger-bg bg-danger-bg px-4 py-3 text-sm text-danger">
          {data.suspendedTenants} organization{data.suspendedTenants === 1 ? "" : "s"} currently
          suspended.{" "}
          <a href="/admin/tenants" className="font-medium underline">
            Review
          </a>
        </div>
      )}

      <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-text-primary">New organizations (30 days)</h2>
        <div className="mt-4">
          <EnrollmentChart data={data.newTenantsByDay} seriesName="New orgs" />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-text-primary">Users by role</h2>
          <ul className="mt-3 flex flex-col gap-2">
            {data.usersByRole.map((r) => (
              <li
                key={r.role}
                className="flex items-center justify-between text-sm text-text-secondary"
              >
                <span>{r.role.replace("_", " ")}</span>
                <span className="font-medium text-text-primary">{r.count}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-text-primary">Organizations by plan</h2>
          <ul className="mt-3 flex flex-col gap-2">
            {data.tenantsByPlan.map((p) => (
              <li
                key={p.plan}
                className="flex items-center justify-between text-sm text-text-secondary"
              >
                <span>{p.plan}</span>
                <span className="font-medium text-text-primary">{p.count}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <p className="text-xs text-text-disabled">
        AI calls used platform-wide this quota period: {data.aiCallsUsedTotal}
      </p>
    </div>
  );
}
