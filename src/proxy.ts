import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { redis } from "@/lib/redis";

const isPublicRoute = createRouteMatcher([
  "/",
  "/suspended",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/onboarding",
  "/api/webhooks/(.*)",
  "/api/uploadthing(.*)",
  "/api/ai/embed-lesson",
  "/api/cron/(.*)",
]);

const isAuthRoute = createRouteMatcher(["/sign-in(.*)", "/sign-up(.*)"]);
const isSuspendedPage = createRouteMatcher(["/suspended"]);

// The apex/root domain. On a subdomain like `acme.lumio.io` the part before this
// (`acme`) is treated as the tenant slug.
const ROOT_DOMAIN = "lumio.io";

// Reserved subdomains that are NOT tenants — the marketing site and the app shell.
const RESERVED_SUBDOMAINS = new Set(["www", "app"]);

// Sentinel cached for slugs that resolve to no tenant, so a flood of requests to a
// bogus subdomain doesn't hammer the DB on every hit.
const TENANT_NONE = "__none__";

/**
 * Derive the tenant slug from the request host.
 *
 * Local development note: real subdomains don't resolve against `localhost`, so on
 * `localhost:3000` we read the slug from a `?tenant=` query param instead. To test a
 * tenant locally: http://localhost:3000/?tenant=acme
 */
function getTenantSlug(host: string, searchParams: URLSearchParams): string | null {
  let slug: string | null = null;

  if (host === "localhost:3000") {
    slug = searchParams.get("tenant");
  } else {
    const hostname = host.split(":")[0];
    if (hostname.endsWith(`.${ROOT_DOMAIN}`)) {
      // Strip the trailing ".lumio.io" — leaves e.g. "acme" (or "www").
      slug = hostname.slice(0, hostname.length - ROOT_DOMAIN.length - 1);
    }
  }

  if (!slug || RESERVED_SUBDOMAINS.has(slug)) return null;
  return slug;
}

/**
 * Resolve a tenant slug to its id, backed by a 5-minute Redis cache. Negative results
 * are cached too. Returns null when no tenant owns the slug.
 */
async function resolveTenantId(slug: string): Promise<string | null> {
  const cacheKey = `tenant:slug:${slug}`;

  const cached = await redis.get<string>(cacheKey);
  if (cached !== null) {
    return cached === TENANT_NONE ? null : cached;
  }

  const tenant = await db.tenant.findUnique({
    where: { slug },
    select: { id: true },
  });

  await redis.set(cacheKey, tenant?.id ?? TENANT_NONE, { ex: 300 });
  return tenant?.id ?? null;
}

/**
 * Whether the signed-in user's tenant has been suspended by a Super Admin
 * (src/app/api/admin/tenants/[tenantId]/route.ts). Cached for 60s per user so a
 * reactivation propagates quickly without hitting the DB on every request.
 */
async function isUserOrgSuspended(clerkId: string): Promise<boolean> {
  const cacheKey = `user:org-suspended:${clerkId}`;

  const cached = await redis.get<string>(cacheKey);
  if (cached !== null) {
    return cached !== TENANT_NONE;
  }

  const user = await db.user.findUnique({
    where: { clerkId },
    select: { tenant: { select: { suspendedAt: true } } },
  });

  const suspended = Boolean(user?.tenant?.suspendedAt);
  await redis.set(cacheKey, suspended ? "1" : TENANT_NONE, { ex: 60 });
  return suspended;
}

export default clerkMiddleware(async (auth, request) => {
  // 1. Strip any inbound `x-tenant-id` FIRST, before anything else. This header is set
  //    only by this middleware after verifying the tenant; a client that forges it would
  //    otherwise impersonate a tenant in Server Components. `headers` is the single
  //    source we forward on every non-redirect path below, so the forged value can never
  //    survive — including on public routes, which must also forward stripped headers.
  const headers = new Headers(request.headers);
  headers.delete("x-tenant-id");

  // 2. Clerk auth.
  const { userId } = await auth();

  // Redirect already-signed-in users away from auth pages.
  if (userId && isAuthRoute(request)) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  if (!isPublicRoute(request)) {
    await auth.protect();
  }

  // 2b. Block app access for members of a suspended tenant. Public marketing pages
  //     and the /suspended page itself stay reachable so the user can see why.
  if (userId && !isPublicRoute(request) && !isSuspendedPage(request)) {
    if (await isUserOrgSuspended(userId)) {
      return NextResponse.redirect(new URL("/suspended", request.url));
    }
  }

  // 3. Subdomain detection.
  const host = request.headers.get("host") ?? "";
  const slug = getTenantSlug(host, request.nextUrl.searchParams);

  // No subdomain (lumio.io / localhost with no ?tenant=): no tenant injection. Forward
  // with the stripped headers so a forged x-tenant-id is dropped here too.
  if (!slug) {
    return NextResponse.next({ request: { headers } });
  }

  // 4. Redis cache → DB lookup.
  const tenantId = await resolveTenantId(slug);
  if (!tenantId) {
    // Unknown tenant. Relative redirect keeps this on the current host (in dev a bogus
    // ?tenant= stays on localhost rather than bouncing to production).
    return NextResponse.redirect(new URL("/not-found", request.url));
  }

  // 5. Inject the verified tenant id for Server Components (read via getTenantFromHeaders).
  headers.set("x-tenant-id", tenantId);

  // 6. URL rewrite: the subdomain root serves the white-label [tenant] landing page.
  //    Without this, `acme.lumio.io/` would hit the marketing homepage and the
  //    [tenant] route would be unreachable. Other paths (e.g. /dashboard) are left as-is
  //    and simply run tenant-scoped via the injected header.
  if (request.nextUrl.pathname === "/") {
    const url = request.nextUrl.clone();
    url.pathname = `/${slug}`;
    return NextResponse.rewrite(url, { request: { headers } });
  }

  return NextResponse.next({ request: { headers } });
});

// Vercel setup for wildcard subdomains (no per-tenant configuration needed):
//   1. Add the wildcard domain `*.lumio.io` in the Vercel project's Domains settings.
//   2. Vercel routes every subdomain to this same deployment automatically, so new
//      tenants work the instant their Tenant row exists — no redeploy, no DNS change.
export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
