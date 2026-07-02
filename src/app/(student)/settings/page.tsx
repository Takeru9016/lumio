import { auth } from "@clerk/nextjs/server";
import { format } from "date-fns";
import { Award, CheckCircle2, ClipboardList, Clock, ExternalLink, Star } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { db } from "@/lib/db";

export default async function StudentSettingsPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const dbUser = await db.user.findUnique({
    where: { clerkId: userId },
    select: { id: true, name: true, email: true, avatarUrl: true },
  });
  if (!dbUser) redirect("/sign-in");

  const [gradedSubmissions, certificates] = await Promise.all([
    db.assignmentSubmission.findMany({
      where: { userId: dbUser.id, status: "GRADED" },
      select: {
        id: true,
        score: true,
        feedback: true,
        gradedAt: true,
        submittedAt: true,
        assignment: {
          select: {
            title: true,
            maxScore: true,
            lesson: {
              select: {
                title: true,
                section: {
                  select: {
                    course: {
                      select: { id: true, title: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
      orderBy: { gradedAt: "desc" },
    }),
    db.certificate.findMany({
      where: { userId: dbUser.id },
      select: {
        id: true,
        certificateUrl: true,
        issuedAt: true,
        course: {
          select: { id: true, title: true, thumbnailUrl: true },
        },
      },
      orderBy: { issuedAt: "desc" },
    }),
  ]);

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-bold text-text-primary">Settings</h1>
        <p className="text-sm text-text-muted">Manage your account and view your grades.</p>
      </div>

      <Tabs defaultValue="assignments">
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="assignments">
            Assignments
            {gradedSubmissions.length > 0 && (
              <span className="ml-1.5 text-[10px] font-semibold bg-success text-white rounded-full px-1.5 py-0.5">
                {gradedSubmissions.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="certificates">
            Certificates
            {certificates.length > 0 && (
              <span className="ml-1.5 text-[10px] font-semibold bg-[var(--color-brand)] text-white rounded-full px-1.5 py-0.5">
                {certificates.length}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        {/* Profile tab */}
        <TabsContent value="profile">
          <div className="bg-surface-1 border border-border rounded-lg p-5 space-y-4 mt-4">
            <div className="flex items-center gap-4">
              {dbUser.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={dbUser.avatarUrl}
                  alt={dbUser.name ?? "Avatar"}
                  className="w-12 h-12 rounded-full object-cover"
                />
              ) : (
                <div className="w-12 h-12 rounded-full bg-surface-3 flex items-center justify-center text-text-muted text-lg font-medium">
                  {(dbUser.name ?? dbUser.email)[0].toUpperCase()}
                </div>
              )}
              <div>
                <p className="text-sm font-semibold text-text-primary">{dbUser.name ?? "—"}</p>
                <p className="text-xs text-text-muted">{dbUser.email}</p>
              </div>
            </div>
            <p className="text-xs text-text-muted">
              Profile details are managed via Clerk. Visit your account settings to update your name
              or avatar.
            </p>
          </div>
        </TabsContent>

        {/* Assignments tab */}
        <TabsContent value="assignments">
          <div className="mt-4 space-y-3">
            {gradedSubmissions.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border bg-surface-2 py-12 text-center">
                <ClipboardList size={28} className="text-text-disabled mx-auto mb-2" />
                <p className="text-sm font-medium text-text-primary mb-1">
                  No graded assignments yet
                </p>
                <p className="text-xs text-text-muted">
                  Grades will appear here once your instructor reviews your work.
                </p>
              </div>
            ) : (
              gradedSubmissions.map((sub) => {
                const course = sub.assignment.lesson.section.course;
                const pct =
                  sub.score !== null
                    ? Math.round((sub.score / sub.assignment.maxScore) * 100)
                    : null;
                return (
                  <div
                    key={sub.id}
                    className="bg-surface-1 border border-border rounded-lg p-4 space-y-2"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-text-primary truncate">
                          {sub.assignment.title}
                        </p>
                        <Link
                          href={`/courses/${course.id}`}
                          className="text-xs text-brand hover:underline"
                        >
                          {course.title}
                        </Link>
                      </div>
                      {sub.score !== null && (
                        <div className="flex items-center gap-1.5 shrink-0">
                          <CheckCircle2 size={14} className="text-success" />
                          <span className="text-sm font-bold text-success">
                            {sub.score}/{sub.assignment.maxScore}
                          </span>
                          {pct !== null && (
                            <span className="text-xs text-text-muted">({pct}%)</span>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-4 text-xs text-text-muted">
                      <span className="flex items-center gap-1">
                        <Star size={11} />
                        {sub.assignment.maxScore} pts
                      </span>
                      {sub.gradedAt && (
                        <span className="flex items-center gap-1">
                          <Clock size={11} />
                          Graded {format(new Date(sub.gradedAt), "MMM d, yyyy")}
                        </span>
                      )}
                    </div>

                    {sub.feedback && (
                      <div className="mt-1 pt-2 border-t border-border">
                        <p className="text-xs font-medium text-text-secondary mb-0.5">
                          Instructor feedback
                        </p>
                        <p className="text-sm text-text-primary">{sub.feedback}</p>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </TabsContent>

        {/* Certificates tab */}
        <TabsContent value="certificates">
          <div className="mt-4">
            {certificates.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border bg-surface-2 py-12 text-center">
                <Award size={28} className="text-text-disabled mx-auto mb-2" />
                <p className="text-sm font-medium text-text-primary mb-1">No certificates yet</p>
                <p className="text-xs text-text-muted mb-4">
                  Complete all lessons and quizzes in a course to earn your certificate.
                </p>
                <Link
                  href="/courses"
                  className="inline-flex items-center gap-1.5 bg-[var(--color-brand)] text-white rounded-md px-4 py-2 text-sm font-medium hover:bg-[var(--color-brand-dark)] transition-colors"
                >
                  Browse courses →
                </Link>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {certificates.map((cert) => (
                  <div
                    key={cert.id}
                    className="bg-surface-1 border border-border rounded-lg overflow-hidden hover:shadow-md transition-shadow"
                  >
                    {/* Thumbnail */}
                    {cert.course.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={cert.course.thumbnailUrl}
                        alt={cert.course.title}
                        className="w-full h-32 object-cover"
                      />
                    ) : (
                      <div className="w-full h-32 bg-[var(--color-brand-light)] flex items-center justify-center">
                        <Award size={32} className="text-[var(--color-brand)]" />
                      </div>
                    )}

                    {/* Info */}
                    <div className="p-4 space-y-3">
                      <div>
                        <p className="text-sm font-semibold text-text-primary leading-snug">
                          {cert.course.title}
                        </p>
                        <p className="text-xs text-text-muted mt-0.5">
                          Issued {format(new Date(cert.issuedAt), "MMM d, yyyy")}
                        </p>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-mono text-text-disabled truncate">
                          {cert.id}
                        </span>
                        <a
                          href={cert.certificateUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs font-medium text-[var(--color-brand)] hover:underline shrink-0 ml-2"
                        >
                          View <ExternalLink size={10} />
                        </a>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
