import { db } from "@/lib/db";

// Kept in sync with RESERVED_SUBDOMAINS in src/proxy.ts — these slugs would otherwise
// collide with the marketing site / app shell on subdomain routing.
const RESERVED_SLUGS = new Set(["www", "app"]);

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "org"
  );
}

export async function generateUniqueTenantSlug(orgName: string): Promise<string> {
  const base = slugify(orgName);

  let candidate = base;
  let suffix = 2;
  while (
    RESERVED_SLUGS.has(candidate) ||
    (await db.tenant.findUnique({ where: { slug: candidate }, select: { id: true } }))
  ) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }

  return candidate;
}
