"use client";

import { format } from "date-fns";
import { toast } from "gooey-toast";
import { ArrowRight, Check, Loader2, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

type RequestType = "SEAT_INCREASE" | "ACCOUNT_CREATE" | "COURSE_CAPACITY" | "OTHER";
type RequestStatus = "PENDING" | "APPROVED" | "DENIED";

interface OrgRequestItem {
  id: string;
  type: RequestType;
  payload: unknown;
  message: string | null;
  status: RequestStatus;
  createdAt: string;
  resolvedAt: string | null;
  requester: { name: string | null; email: string };
}

const TYPE_LABEL: Record<RequestType, string> = {
  SEAT_INCREASE: "More seats",
  ACCOUNT_CREATE: "New account",
  COURSE_CAPACITY: "More course capacity",
  OTHER: "Something else",
};

const STATUS_BADGE: Record<RequestStatus, string> = {
  PENDING: "bg-surface-3 text-text-muted",
  APPROVED: "bg-success-bg text-success",
  DENIED: "bg-danger-bg text-danger",
};

function describePayload(type: RequestType, payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (type === "SEAT_INCREASE" && "requestedSeats" in p) return `${p.requestedSeats} seats`;
  if (type === "COURSE_CAPACITY" && "requestedCourses" in p) return `${p.requestedCourses} courses`;
  if (type === "ACCOUNT_CREATE" && "email" in p) return `${p.email} · ${p.role}`;
  return null;
}

// Type-specific downstream action: real seat/plan changes stay inside the
// existing billing flow, and account creation deep-links into the P0 invite
// dialog (pre-filled) rather than an OrgRequest auto-applying anything itself.
function downstreamLink(item: OrgRequestItem): { href: string; label: string } | null {
  if (item.type === "SEAT_INCREASE" || item.type === "COURSE_CAPACITY") {
    return { href: "/org/settings/billing", label: "Review plan" };
  }
  if (item.type === "ACCOUNT_CREATE" && item.payload && typeof item.payload === "object") {
    const p = item.payload as { email?: string; role?: string };
    if (p.email) {
      const params = new URLSearchParams({ inviteEmail: p.email, inviteRole: p.role ?? "STUDENT" });
      return { href: `/org/teams?${params.toString()}`, label: "Invite now" };
    }
  }
  return null;
}

interface OrgRequestsClientProps {
  initialRequests: OrgRequestItem[];
}

export function OrgRequestsClient({ initialRequests }: OrgRequestsClientProps) {
  const router = useRouter();
  const [requests, setRequests] = useState(initialRequests);
  const [pendingId, setPendingId] = useState<string | null>(null);

  async function handleResolve(id: string, status: "APPROVED" | "DENIED") {
    setPendingId(id);
    try {
      const res = await fetch(`/api/org-requests/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(data?.error ?? "Couldn't update request");

      setRequests((prev) =>
        prev.map((r) => (r.id === id ? { ...r, status, resolvedAt: new Date().toISOString() } : r))
      );
      toast.success({ title: status === "APPROVED" ? "Request approved" : "Request denied" });
      router.refresh();
    } catch (err) {
      toast.error({ title: err instanceof Error ? err.message : "Couldn't update request" });
    } finally {
      setPendingId(null);
    }
  }

  if (requests.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-surface-2 py-12 text-center">
        <p className="text-sm font-medium text-text-primary mb-1">No requests yet</p>
        <p className="text-xs text-text-muted">Requests from your instructors will show up here.</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-white overflow-hidden shadow-sm">
      <div className="divide-y divide-border">
        {requests.map((r) => {
          const link = downstreamLink(r);
          return (
            <div key={r.id} className="flex items-start justify-between gap-4 px-4 py-3.5">
              <div className="min-w-0">
                <p className="text-sm font-medium text-text-primary">
                  {TYPE_LABEL[r.type]}
                  {describePayload(r.type, r.payload) && (
                    <span className="text-text-muted font-normal">
                      {" "}
                      · {describePayload(r.type, r.payload)}
                    </span>
                  )}
                </p>
                <p className="text-xs text-text-muted mt-0.5">
                  {r.requester.name ?? r.requester.email}
                </p>
                {r.message && <p className="text-xs text-text-muted mt-1">{r.message}</p>}
                <p className="text-xs text-text-disabled mt-1">
                  {format(new Date(r.createdAt), "MMM d, yyyy")}
                </p>
                {link && (
                  <Link
                    href={link.href}
                    className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:opacity-70 transition-opacity mt-1.5"
                  >
                    {link.label} <ArrowRight size={12} />
                  </Link>
                )}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {r.status === "PENDING" ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void handleResolve(r.id, "APPROVED")}
                      disabled={pendingId === r.id}
                      className="inline-flex items-center gap-1 rounded-md bg-success-bg px-2.5 py-1.5 text-xs font-medium text-success hover:opacity-80 transition-opacity disabled:opacity-50"
                    >
                      {pendingId === r.id ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Check size={12} />
                      )}
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleResolve(r.id, "DENIED")}
                      disabled={pendingId === r.id}
                      className="inline-flex items-center gap-1 rounded-md bg-danger-bg px-2.5 py-1.5 text-xs font-medium text-danger hover:opacity-80 transition-opacity disabled:opacity-50"
                    >
                      <X size={12} />
                      Deny
                    </button>
                  </>
                ) : (
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_BADGE[r.status]}`}
                  >
                    {r.status}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
