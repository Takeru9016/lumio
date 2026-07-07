"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import type { TenantListItem } from "@/lib/admin-tenants";

interface TenantsClientProps {
  initialTenants: TenantListItem[];
}

export function TenantsClient({ initialTenants }: TenantsClientProps) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return initialTenants;
    return initialTenants.filter(
      (t) => t.name.toLowerCase().includes(q) || t.slug.toLowerCase().includes(q)
    );
  }, [initialTenants, search]);

  async function toggleSuspended(tenantId: string, suspended: boolean) {
    setPendingId(tenantId);
    try {
      const res = await fetch(`/api/admin/tenants/${tenantId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suspended }),
      });
      if (!res.ok) throw new Error("Request failed");
      router.refresh();
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="space-y-4">
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by name or slug"
        className="w-full max-w-sm rounded-md border border-border bg-white px-3 py-2 text-sm text-text-primary placeholder:text-text-disabled focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand"
      />

      <div className="overflow-x-auto rounded-lg border border-border bg-white">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-2">
              <th className="px-4 py-3 font-medium text-text-muted">Organization</th>
              <th className="px-4 py-3 font-medium text-text-muted">Plan</th>
              <th className="px-4 py-3 font-medium text-text-muted">Seats</th>
              <th className="px-4 py-3 font-medium text-text-muted">Members</th>
              <th className="px-4 py-3 font-medium text-text-muted">Status</th>
              <th className="px-4 py-3 font-medium text-text-muted">Created</th>
              <th className="px-4 py-3 font-medium text-text-muted" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((tenant) => {
              const isSuspended = Boolean(tenant.suspendedAt);
              return (
                <tr key={tenant.id} className="border-b border-border last:border-b-0">
                  <td className="px-4 py-3">
                    <p className="font-medium text-text-primary">{tenant.name}</p>
                    <p className="text-xs text-text-muted">{tenant.slug}</p>
                  </td>
                  <td className="px-4 py-3 text-text-secondary">{tenant.plan}</td>
                  <td className="px-4 py-3 text-text-secondary">
                    {tenant.seatCount}/{tenant.seatLimit}
                  </td>
                  <td className="px-4 py-3 text-text-secondary">{tenant.memberCount}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        isSuspended ? "bg-danger-bg text-danger" : "bg-success-bg text-success"
                      }`}
                    >
                      {isSuspended ? "Suspended" : "Active"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-text-secondary">
                    {tenant.createdAt.toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <button
                          type="button"
                          disabled={pendingId === tenant.id}
                          className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                            isSuspended
                              ? "border-border bg-white text-text-primary hover:bg-surface-2"
                              : "border-danger-bg bg-danger-bg text-danger hover:opacity-90"
                          }`}
                        >
                          {isSuspended ? "Reactivate" : "Suspend"}
                        </button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogTitle>
                          {isSuspended ? "Reactivate" : "Suspend"} {tenant.name}?
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          {isSuspended
                            ? "This restores access for every member of this organization immediately."
                            : "Every member of this organization will be signed out of the app and redirected to a suspension notice until reactivated."}
                        </AlertDialogDescription>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => toggleSuspended(tenant.id, !isSuspended)}
                          >
                            {isSuspended ? "Reactivate" : "Suspend"}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
