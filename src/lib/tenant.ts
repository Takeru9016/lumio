import type { Tenant } from "@/generated/prisma/client";

import { db } from "@/lib/db";

/**
 * Loads the current request's tenant from the `x-tenant-id` header injected by the
 * middleware (src/proxy.ts) after it verifies the subdomain. Returns null when the
 * request isn't tenant-scoped (no subdomain) or the tenant no longer exists.
 *
 * The header is only ever set by the middleware and is stripped from inbound requests
 * before anything trusts it, so an id present here is already verified — we just hydrate
 * the full row from the DB.
 */
export async function getTenantFromHeaders(headers: Headers): Promise<Tenant | null> {
  const tenantId = headers.get("x-tenant-id");
  if (!tenantId) return null;

  return db.tenant.findUnique({ where: { id: tenantId } });
}
