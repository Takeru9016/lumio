import { TenantsClient } from "@/components";
import { getAllTenants } from "@/lib/admin-tenants";

export default async function AdminTenantsPage() {
  const tenants = await getAllTenants();

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div>
        <h1
          className="text-xl font-semibold text-text-primary"
          style={{ fontFamily: "var(--font-heading)" }}
        >
          Organizations
        </h1>
        <p className="text-sm text-text-muted">
          {tenants.length} organization{tenants.length === 1 ? "" : "s"} on the platform.
        </p>
      </div>

      <TenantsClient initialTenants={tenants} />
    </div>
  );
}
