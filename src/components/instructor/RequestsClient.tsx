"use client";

import { format } from "date-fns";
import { toast } from "gooey-toast";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type RequestType = "SEAT_INCREASE" | "ACCOUNT_CREATE" | "COURSE_CAPACITY" | "OTHER";
type RequestStatus = "PENDING" | "APPROVED" | "DENIED";

interface RequestItem {
  id: string;
  type: RequestType;
  payload: unknown;
  message: string | null;
  status: RequestStatus;
  createdAt: string;
  resolvedAt: string | null;
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

interface RequestsClientProps {
  initialRequests: RequestItem[];
}

export function RequestsClient({ initialRequests }: RequestsClientProps) {
  const router = useRouter();
  const [requests, setRequests] = useState(initialRequests);
  const [type, setType] = useState<RequestType>("SEAT_INCREASE");
  const [requestedSeats, setRequestedSeats] = useState("");
  const [requestedCourses, setRequestedCourses] = useState("");
  const [accountName, setAccountName] = useState("");
  const [accountEmail, setAccountEmail] = useState("");
  const [accountRole, setAccountRole] = useState<"STUDENT" | "INSTRUCTOR">("STUDENT");
  const [message, setMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  function buildPayload(): { payload: Record<string, unknown>; error?: string } {
    if (type === "SEAT_INCREASE") {
      const n = Number(requestedSeats);
      if (!Number.isInteger(n) || n <= 0) return { payload: {}, error: "Enter a valid seat count" };
      return { payload: { requestedSeats: n } };
    }
    if (type === "COURSE_CAPACITY") {
      const n = Number(requestedCourses);
      if (!Number.isInteger(n) || n <= 0)
        return { payload: {}, error: "Enter a valid course count" };
      return { payload: { requestedCourses: n } };
    }
    if (type === "ACCOUNT_CREATE") {
      if (!accountEmail.trim()) return { payload: {}, error: "Email is required" };
      return {
        payload: {
          email: accountEmail.trim().toLowerCase(),
          role: accountRole,
          ...(accountName.trim() ? { name: accountName.trim() } : {}),
        },
      };
    }
    return { payload: {} };
  }

  async function handleSubmit() {
    const { payload, error } = buildPayload();
    if (error) {
      toast.error({ title: error });
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await fetch("/api/org-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, payload, message: message.trim() || undefined }),
      });
      const data = (await res.json().catch(() => null)) as {
        request?: RequestItem;
        error?: string;
      } | null;
      if (!res.ok || !data?.request) throw new Error(data?.error ?? "Couldn't send request");

      setRequests((prev) => [data.request as RequestItem, ...prev]);
      setRequestedSeats("");
      setRequestedCourses("");
      setAccountName("");
      setAccountEmail("");
      setMessage("");
      toast.success({ title: "Request sent to your org admin" });
      router.refresh();
    } catch (err) {
      toast.error({ title: err instanceof Error ? err.message : "Couldn't send request" });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-border bg-white p-5 shadow-sm space-y-4">
        <p className="text-sm font-semibold text-text-primary">New request</p>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-text-muted" htmlFor="request-type">
            Type
          </label>
          <Select value={type} onValueChange={(v) => setType(v as RequestType)}>
            <SelectTrigger id="request-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(TYPE_LABEL) as RequestType[]).map((t) => (
                <SelectItem key={t} value={t}>
                  {TYPE_LABEL[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {type === "SEAT_INCREASE" && (
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-text-muted" htmlFor="requested-seats">
              How many seats do you need?
            </label>
            <input
              id="requested-seats"
              type="number"
              min={1}
              value={requestedSeats}
              onChange={(e) => setRequestedSeats(e.target.value)}
              className="w-full rounded-md border border-border px-3 py-2 text-sm"
              placeholder="e.g. 5"
            />
          </div>
        )}

        {type === "COURSE_CAPACITY" && (
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-text-muted" htmlFor="requested-courses">
              How many additional courses do you need?
            </label>
            <input
              id="requested-courses"
              type="number"
              min={1}
              value={requestedCourses}
              onChange={(e) => setRequestedCourses(e.target.value)}
              className="w-full rounded-md border border-border px-3 py-2 text-sm"
              placeholder="e.g. 3"
            />
          </div>
        )}

        {type === "ACCOUNT_CREATE" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-text-muted" htmlFor="account-name">
                Name (optional)
              </label>
              <input
                id="account-name"
                value={accountName}
                onChange={(e) => setAccountName(e.target.value)}
                className="w-full rounded-md border border-border px-3 py-2 text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-text-muted" htmlFor="account-email">
                Email
              </label>
              <input
                id="account-email"
                type="email"
                value={accountEmail}
                onChange={(e) => setAccountEmail(e.target.value)}
                className="w-full rounded-md border border-border px-3 py-2 text-sm"
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <span className="text-xs font-medium text-text-muted">Role</span>
              <div className="flex gap-2">
                {(["STUDENT", "INSTRUCTOR"] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setAccountRole(r)}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
                      accountRole === r
                        ? "bg-brand text-white border-brand"
                        : "border-border text-text-muted hover:bg-surface-2"
                    }`}
                  >
                    {r === "STUDENT" ? "Student" : "Instructor"}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-text-muted" htmlFor="request-message">
            Message (optional)
          </label>
          <textarea
            id="request-message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={3}
            className="w-full rounded-md border border-border px-3 py-2 text-sm resize-none"
            placeholder="Any context for your admin"
          />
        </div>

        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={isSubmitting}
          className="inline-flex items-center gap-1.5 rounded-md bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-dark disabled:opacity-60"
        >
          {isSubmitting && <Loader2 size={14} className="animate-spin" />}
          Send request
        </button>
      </div>

      <div className="rounded-lg border border-border bg-white overflow-hidden shadow-sm">
        <div className="px-4 py-3 border-b border-border">
          <p className="text-sm font-semibold text-text-primary">Your requests</p>
        </div>
        {requests.length === 0 ? (
          <p className="px-4 py-6 text-sm text-text-muted text-center">
            You haven't sent any requests yet.
          </p>
        ) : (
          <div className="divide-y divide-border">
            {requests.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-4 px-4 py-3">
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
                  {r.message && <p className="text-xs text-text-muted mt-0.5">{r.message}</p>}
                  <p className="text-xs text-text-disabled mt-0.5">
                    {format(new Date(r.createdAt), "MMM d, yyyy")}
                  </p>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_BADGE[r.status]}`}
                >
                  {r.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
