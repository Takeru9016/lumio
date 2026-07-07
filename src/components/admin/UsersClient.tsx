"use client";

import { useState, useTransition } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Plan, Role } from "@/generated/prisma/enums";
import type { AdminUserListItem } from "@/lib/admin-users";

const ROLES: Role[] = ["STUDENT", "INSTRUCTOR", "ORG_ADMIN", "SUPER_ADMIN"];
const PLANS: Plan[] = ["FREE", "STARTER", "PRO", "ENTERPRISE"];

interface UsersClientProps {
  initialUsers: AdminUserListItem[];
}

export function UsersClient({ initialUsers }: UsersClientProps) {
  const [users, setUsers] = useState(initialUsers);
  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState<Role | "ALL">("ALL");
  const [pendingRoleChange, setPendingRoleChange] = useState<{
    userId: string;
    role: Role;
  } | null>(null);
  const [isSearching, startSearch] = useTransition();

  function runSearch(nextQ: string, nextRole: Role | "ALL") {
    startSearch(async () => {
      const params = new URLSearchParams();
      if (nextQ.trim()) params.set("q", nextQ.trim());
      if (nextRole !== "ALL") params.set("role", nextRole);
      const res = await fetch(`/api/admin/users?${params.toString()}`);
      if (res.ok) {
        const data = (await res.json()) as { users: AdminUserListItem[] };
        setUsers(data.users);
      }
    });
  }

  async function changePlan(userId: string, plan: Plan) {
    const res = await fetch(`/api/admin/users/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan }),
    });
    if (res.ok) {
      setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, plan } : u)));
    }
  }

  async function confirmRoleChange() {
    if (!pendingRoleChange) return;
    const { userId, role } = pendingRoleChange;
    const res = await fetch(`/api/admin/users/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    if (res.ok) {
      setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, role } : u)));
    }
    setPendingRoleChange(null);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            runSearch(e.target.value, roleFilter);
          }}
          placeholder="Search by name or email"
          className="w-full max-w-sm rounded-md border border-border bg-white px-3 py-2 text-sm text-text-primary placeholder:text-text-disabled focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand"
        />
        <Select
          value={roleFilter}
          onValueChange={(value) => {
            const next = value as Role | "ALL";
            setRoleFilter(next);
            runSearch(q, next);
          }}
        >
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All roles</SelectItem>
            {ROLES.map((role) => (
              <SelectItem key={role} value={role}>
                {role.replace("_", " ")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {isSearching && <span className="text-xs text-text-muted">Searching...</span>}
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-white">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-2">
              <th className="px-4 py-3 font-medium text-text-muted">User</th>
              <th className="px-4 py-3 font-medium text-text-muted">Organization</th>
              <th className="px-4 py-3 font-medium text-text-muted">Role</th>
              <th className="px-4 py-3 font-medium text-text-muted">Plan</th>
              <th className="px-4 py-3 font-medium text-text-muted">Joined</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id} className="border-b border-border last:border-b-0">
                <td className="px-4 py-3">
                  <p className="font-medium text-text-primary">{user.name ?? "Unnamed"}</p>
                  <p className="text-xs text-text-muted">{user.email}</p>
                </td>
                <td className="px-4 py-3 text-text-secondary">{user.tenantName ?? "-"}</td>
                <td className="px-4 py-3">
                  <Select
                    value={user.role}
                    onValueChange={(value) =>
                      setPendingRoleChange({ userId: user.id, role: value as Role })
                    }
                  >
                    <SelectTrigger className="w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ROLES.map((role) => (
                        <SelectItem key={role} value={role}>
                          {role.replace("_", " ")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </td>
                <td className="px-4 py-3">
                  <Select
                    value={user.plan}
                    onValueChange={(value) => changePlan(user.id, value as Plan)}
                  >
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PLANS.map((plan) => (
                        <SelectItem key={plan} value={plan}>
                          {plan}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </td>
                <td className="px-4 py-3 text-text-secondary">
                  {user.createdAt.toLocaleDateString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <AlertDialog
        open={pendingRoleChange !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRoleChange(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>Change this user's role?</AlertDialogTitle>
          <AlertDialogDescription>
            {pendingRoleChange &&
              `This immediately changes what they can access, to ${pendingRoleChange.role.replace("_", " ")}.`}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRoleChange}>Change role</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
