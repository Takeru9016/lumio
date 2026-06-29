import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { format } from "date-fns";
import { Award, ExternalLink } from "lucide-react";

import { db } from "@/lib";

export default async function OrgReportsPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true, role: true, tenantId: true },
  });
  if (!dbUser || dbUser.role !== "ORG_ADMIN") redirect("/dashboard");

  const certificates = dbUser.tenantId
    ? await db.certificate.findMany({
        where: { user: { tenantId: dbUser.tenantId } },
        select: {
          id: true,
          certificateUrl: true,
          issuedAt: true,
          user: { select: { name: true, email: true } },
          course: { select: { title: true } },
        },
        orderBy: { issuedAt: "desc" },
      })
    : [];

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-8">
      <div>
        <h1
          className="text-xl font-bold text-text-primary"
          style={{ fontFamily: "var(--font-heading)" }}
        >
          Reports
        </h1>
        <p className="text-sm text-text-muted">
          Activity and compliance data for your organisation.
        </p>
      </div>

      {/* Certificates Issued */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Award size={16} className="text-[var(--color-brand)]" />
            <h2 className="text-base font-semibold text-text-primary">
              Certificates Issued
            </h2>
            {certificates.length > 0 && (
              <span className="text-xs font-medium text-text-muted bg-surface-3 rounded-full px-2 py-0.5">
                {certificates.length}
              </span>
            )}
          </div>
        </div>

        {certificates.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-surface-2 py-12 text-center">
            <Award size={28} className="text-text-disabled mx-auto mb-2" />
            <p className="text-sm font-medium text-text-primary mb-1">
              No certificates issued yet
            </p>
            <p className="text-xs text-text-muted">
              Certificates appear here when members complete courses.
            </p>
          </div>
        ) : (
          <div className="bg-white border border-border rounded-lg overflow-hidden shadow-sm">
            {/* Table header */}
            <div className="grid grid-cols-[1fr_1.5fr_140px_96px_48px] px-4 py-2.5 border-b border-border bg-surface-2">
              <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">
                Student
              </span>
              <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">
                Course
              </span>
              <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">
                Issued
              </span>
              <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">
                Cert ID
              </span>
              <span className="sr-only">Link</span>
            </div>

            {/* Table rows */}
            {certificates.map((cert) => (
              <div
                key={cert.id}
                className="grid grid-cols-[1fr_1.5fr_140px_96px_48px] items-center px-4 py-3 border-b border-border last:border-0 hover:bg-surface-2 transition-colors"
              >
                {/* Student */}
                <div className="min-w-0">
                  <p className="text-sm font-medium text-text-primary truncate">
                    {cert.user.name ?? cert.user.email}
                  </p>
                  {cert.user.name && (
                    <p className="text-xs text-text-muted truncate">
                      {cert.user.email}
                    </p>
                  )}
                </div>

                {/* Course */}
                <p className="text-sm text-text-secondary truncate pr-4">
                  {cert.course.title}
                </p>

                {/* Date */}
                <p className="text-sm text-text-muted">
                  {format(new Date(cert.issuedAt), "MMM d, yyyy")}
                </p>

                {/* Cert ID */}
                <p className="text-[11px] font-mono text-text-disabled truncate">
                  {cert.id.slice(0, 8)}…
                </p>

                {/* Link */}
                <div className="flex justify-center">
                  <a
                    href={cert.certificateUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[var(--color-brand)] hover:opacity-70 transition-opacity"
                    title="View certificate"
                  >
                    <ExternalLink size={14} />
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
