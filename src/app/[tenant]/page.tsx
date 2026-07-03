import { headers } from "next/headers";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";

import { db } from "@/lib/db";
import { getTenantFromHeaders } from "@/lib/tenant";
import { getTenantCss } from "@/lib/tenant-css";

interface TenantLandingPageProps {
  params: Promise<{ tenant: string }>;
}

export default async function TenantLandingPage({ params }: TenantLandingPageProps) {
  const { tenant: slug } = await params;

  // Prefer the tenant verified by the middleware (x-tenant-id header). Fall back to the
  // slug in the URL for direct navigations that didn't pass through subdomain rewriting.
  const headerList = await headers();
  const tenant =
    (await getTenantFromHeaders(headerList)) ?? (await db.tenant.findUnique({ where: { slug } }));

  if (!tenant) notFound();

  const courses = await db.course.findMany({
    where: { tenantId: tenant.id, status: "PUBLISHED" },
    orderBy: { publishedAt: "desc" },
    take: 6,
    select: { id: true, title: true, description: true, thumbnailUrl: true },
  });

  // Scope the tenant's brand colour to this page via [data-tenant]; getTenantCss returns
  // "" for any non-hex value, so the injected CSS is safe.
  const tenantCss = getTenantCss(tenant);

  return (
    <div data-tenant={tenant.id} className="min-h-screen bg-surface-1 text-text-primary">
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: getTenantCss emits only hex-validated custom-property values. */}
      {tenantCss && <style dangerouslySetInnerHTML={{ __html: tenantCss }} />}

      <header className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div className="flex items-center gap-2">
          {tenant.logoUrl ? (
            // biome-ignore lint/performance/noImgElement: tenant logos are arbitrary external hosts, not in next/image remotePatterns.
            <img src={tenant.logoUrl} alt={`${tenant.name} logo`} className="h-8 w-auto" />
          ) : (
            <span className="text-lg font-semibold">{tenant.name}</span>
          )}
        </div>
        <Link
          href="/sign-in"
          className="px-4 py-2 text-sm font-semibold rounded-lg bg-brand text-white hover:bg-brand-dark transition-colors"
        >
          Sign in
        </Link>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-16">
        <section className="text-center max-w-2xl mx-auto">
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">
            Learn with {tenant.name}
          </h1>
          <p className="mt-4 text-text-muted">
            Your team's learning home — courses, progress, and certifications in one place.
          </p>
          <Link
            href="/sign-in"
            className="inline-flex mt-8 px-6 py-3 text-sm font-semibold rounded-lg bg-brand text-white hover:bg-brand-dark transition-colors"
          >
            Get started
          </Link>
        </section>

        <section className="mt-16">
          <h2 className="text-lg font-semibold mb-6">Featured courses</h2>

          {courses.length === 0 ? (
            <div className="border border-dashed border-border rounded-xl py-16 text-center text-text-muted">
              <p className="text-3xl mb-3">📚</p>
              <p className="text-sm">No published courses yet — check back soon.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
              {courses.map((course) => (
                <article
                  key={course.id}
                  className="bg-surface-1 border border-border rounded-xl overflow-hidden flex flex-col"
                >
                  <div className="relative aspect-video bg-surface-3">
                    {course.thumbnailUrl ? (
                      <Image
                        src={course.thumbnailUrl}
                        alt={course.title}
                        fill
                        className="object-cover"
                        sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
                      />
                    ) : (
                      <div className="absolute inset-0 flex items-center justify-center text-3xl">
                        📚
                      </div>
                    )}
                  </div>
                  <div className="p-4 flex flex-col gap-2 flex-1">
                    <h3 className="font-semibold text-sm leading-snug line-clamp-2">
                      {course.title}
                    </h3>
                    {course.description && (
                      <p className="text-xs text-text-muted line-clamp-2">{course.description}</p>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
