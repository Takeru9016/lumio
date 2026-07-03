import { auth } from "@clerk/nextjs/server";
import { format } from "date-fns";
import { Award, ExternalLink, Sparkles } from "lucide-react";
import { redirect } from "next/navigation";

import { CompletionReportClient } from "@/components";
import { AiBadge } from "@/components/shared/AiBadge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { db } from "@/lib/db";
import { getCompletionReport } from "@/lib/reports";

export default async function OrgReportsPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true, role: true, tenantId: true },
  });
  if (!dbUser || dbUser.role !== "ORG_ADMIN") redirect("/dashboard");

  const tenantId = dbUser.tenantId;

  const [certificates, teams, courses, completionRows] = tenantId
    ? await Promise.all([
        db.certificate.findMany({
          where: { user: { tenantId } },
          select: {
            id: true,
            certificateUrl: true,
            issuedAt: true,
            user: { select: { name: true, email: true } },
            course: { select: { title: true } },
          },
          orderBy: { issuedAt: "desc" },
        }),
        db.team.findMany({
          where: { tenantId },
          select: { id: true, name: true },
          orderBy: { name: "asc" },
        }),
        db.course.findMany({
          where: { tenantId },
          select: { id: true, title: true },
          orderBy: { title: "asc" },
        }),
        getCompletionReport(tenantId, {}),
      ])
    : [[], [], [], []];

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
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

      <Tabs defaultValue="completion">
        <TabsList>
          <TabsTrigger value="completion">Completion Report</TabsTrigger>
          <TabsTrigger value="certificates">Certificate Log</TabsTrigger>
          <TabsTrigger value="skills-gap">Skills Gap</TabsTrigger>
        </TabsList>

        {/* Completion Report */}
        <TabsContent value="completion">
          <CompletionReportClient initialRows={completionRows} teams={teams} courses={courses} />
        </TabsContent>

        {/* Certificate Log */}
        <TabsContent value="certificates">
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
              <div className="grid grid-cols-[1fr_1.5fr_140px_96px_48px] px-4 py-2.5 border-b border-border bg-surface-2">
                <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">
                  Member
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

              {certificates.map((cert) => (
                <div
                  key={cert.id}
                  className="grid grid-cols-[1fr_1.5fr_140px_96px_48px] items-center px-4 py-3 border-b border-border last:border-0 hover:bg-surface-2 transition-colors"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text-primary truncate">
                      {cert.user.name ?? cert.user.email}
                    </p>
                    {cert.user.name && (
                      <p className="text-xs text-text-muted truncate">{cert.user.email}</p>
                    )}
                  </div>

                  <p className="text-sm text-text-secondary truncate pr-4">{cert.course.title}</p>

                  <p className="text-sm text-text-muted">
                    {format(new Date(cert.issuedAt), "MMM d, yyyy")}
                  </p>

                  <p className="text-[11px] font-mono text-text-disabled truncate">
                    {cert.id.slice(0, 8)}…
                  </p>

                  <div className="flex justify-center">
                    <a
                      href={cert.certificateUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[var(--color-brand)] hover:opacity-70 transition-opacity"
                      title="Download cert"
                    >
                      <ExternalLink size={14} />
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Skills Gap (AI placeholder) */}
        <TabsContent value="skills-gap">
          <div className="rounded-lg border border-(--color-ai)/20 bg-(--color-ai-bg) p-8 text-center">
            <div className="flex justify-center mb-3">
              <AiBadge label="AI" size="md" />
            </div>
            <Sparkles size={24} className="text-(--color-ai) mx-auto mb-3" />
            <p className="text-sm font-medium text-text-primary mb-1">
              Skills gap analysis is coming soon
            </p>
            <p className="text-xs text-text-muted max-w-sm mx-auto">
              Lumio will analyse quiz performance and course completion across your organisation to
              surface skill gaps and recommend targeted training.
            </p>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
