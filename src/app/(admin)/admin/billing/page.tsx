import { getPlatformBillingData } from "@/lib/admin-billing";

export default async function AdminBillingPage() {
  const data = await getPlatformBillingData();

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <h1
          className="text-xl font-semibold text-text-primary"
          style={{ fontFamily: "var(--font-heading)" }}
        >
          Billing overview
        </h1>
        <p className="text-sm text-text-muted">
          Reflects the <code className="font-mono text-xs">plan</code> and{" "}
          <code className="font-mono text-xs">subscriptionStatus</code> fields on Users and Tenants.
          Lumio does not have a payment ledger yet, so this is not a real revenue report, it's a
          snapshot of who's on which plan and subscription state.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
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

        <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-text-primary">Users by plan</h2>
          <ul className="mt-3 flex flex-col gap-2">
            {data.usersByPlan.map((p) => (
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

      <div className="rounded-lg border border-border bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-text-primary">Subscription status</h2>
        {data.subscriptionStatusBreakdown.length === 0 ? (
          <p className="mt-3 text-sm text-text-muted">No paid subscriptions recorded yet.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {data.subscriptionStatusBreakdown.map((s) => (
              <li
                key={s.status}
                className="flex items-center justify-between text-sm text-text-secondary"
              >
                <span>{s.status}</span>
                <span className="font-medium text-text-primary">{s.count}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
