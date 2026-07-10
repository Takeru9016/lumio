"use client";

import { toast } from "gooey-toast";
import { Mail, Plus, UserMinus, UserPlus, Users2, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

type Role = "STUDENT" | "INSTRUCTOR" | "ORG_ADMIN" | "SUPER_ADMIN";
type InvitableRole = "STUDENT" | "INSTRUCTOR";

interface TeamMemberData {
  user: { id: string; name: string | null; email: string; role: Role };
}

interface TeamData {
  id: string;
  name: string;
  members: TeamMemberData[];
}

interface InvitationData {
  id: string;
  email: string;
  role: Role;
  createdAt: Date;
  expiresAt: Date;
}

interface TeamsClientProps {
  initialTeams: TeamData[];
  seatCount: number;
  seatLimit: number;
  initialInvitations: InvitationData[];
}

const roleBadgeStyles: Record<Role, string> = {
  STUDENT: "bg-[var(--color-surface-3)] text-[var(--color-text-muted)]",
  INSTRUCTOR: "bg-[var(--color-info-bg)] text-[var(--color-info)]",
  ORG_ADMIN: "bg-[var(--color-brand-light)] text-[var(--color-brand)]",
  SUPER_ADMIN: "bg-[var(--color-warning-bg)] text-[var(--color-warning)]",
};

export function TeamsClient({
  initialTeams,
  seatCount,
  seatLimit,
  initialInvitations,
}: TeamsClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [createOpen, setCreateOpen] = useState(false);
  const [teamName, setTeamName] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  const [detailTeamId, setDetailTeamId] = useState<string | null>(null);
  const [addEmail, setAddEmail] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<{ userId: string; name: string } | null>(null);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<InvitableRole>("STUDENT");
  const [isInviting, setIsInviting] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; email: string } | null>(null);

  const isSeatLimitReached = seatCount >= seatLimit;
  const isSeatLimitNearFull = !isSeatLimitReached && seatLimit > 0 && seatCount / seatLimit > 0.8;
  const detailTeam = initialTeams.find((t) => t.id === detailTeamId) ?? null;

  // Deep-link from an approved ACCOUNT_CREATE org request (see org/requests) —
  // pre-fills and opens the invite dialog instead of making the admin retype it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only ever needs to run once, on the deep-link that mounted this page
  useEffect(() => {
    const email = searchParams.get("inviteEmail");
    const role = searchParams.get("inviteRole");
    if (!email) return;
    setInviteEmail(email);
    if (role === "STUDENT" || role === "INSTRUCTOR") setInviteRole(role);
    setInviteOpen(true);
  }, []);

  async function handleCreateTeam() {
    if (teamName.trim().length === 0) return;
    setIsCreating(true);
    try {
      const res = await fetch("/api/org/teams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: teamName.trim() }),
      });
      if (!res.ok) throw new Error();
      toast.success({ title: "Team created" });
      setTeamName("");
      setCreateOpen(false);
      router.refresh();
    } catch {
      toast.error({ title: "Couldn't create team" });
    } finally {
      setIsCreating(false);
    }
  }

  async function handleAddMember(teamId: string) {
    if (addEmail.trim().length === 0) return;
    setIsAdding(true);
    try {
      const res = await fetch(`/api/org/teams/${teamId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: addEmail.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Couldn't add member");
      toast.success({ title: "Member added" });
      setAddEmail("");
      router.refresh();
    } catch (err) {
      toast.error({ title: err instanceof Error ? err.message : "Couldn't add member" });
    } finally {
      setIsAdding(false);
    }
  }

  async function handleInvite() {
    if (inviteEmail.trim().length === 0) return;
    setIsInviting(true);
    try {
      const res = await fetch("/api/org/invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Couldn't send invitation");
      toast.success({ title: "Invitation sent", description: inviteEmail.trim() });
      setInviteEmail("");
      setInviteRole("STUDENT");
      setInviteOpen(false);
      router.refresh();
    } catch (err) {
      toast.error({ title: err instanceof Error ? err.message : "Couldn't send invitation" });
    } finally {
      setIsInviting(false);
    }
  }

  async function handleRevokeInvitation(invitationId: string) {
    try {
      const res = await fetch(`/api/org/invitations/${invitationId}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      toast.success({ title: "Invitation revoked" });
      router.refresh();
    } catch {
      toast.error({ title: "Couldn't revoke invitation" });
    } finally {
      setRevokeTarget(null);
    }
  }

  async function handleRemoveMember(teamId: string, userId: string) {
    try {
      const res = await fetch(`/api/org/teams/${teamId}/members/${userId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error();
      toast.success({ title: "Member removed" });
      router.refresh();
    } catch {
      toast.error({ title: "Couldn't remove member" });
    } finally {
      setRemoveTarget(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          {isSeatLimitReached ? (
            <span className="inline-flex items-center rounded-full bg-danger-bg px-2.5 py-0.5 text-xs font-medium text-danger">
              Seats full ({seatCount}/{seatLimit})
            </span>
          ) : (
            isSeatLimitNearFull && (
              <span className="inline-flex items-center rounded-full bg-warning-bg px-2.5 py-0.5 text-xs font-medium text-warning">
                {seatCount}/{seatLimit} seats used
              </span>
            )
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setInviteOpen(true)}
            disabled={isSeatLimitReached}
            className="inline-flex items-center gap-1.5 border border-border bg-white text-text-primary rounded-md
                       px-4 py-2 text-sm font-medium hover:bg-surface-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <UserPlus size={14} />
            Invite member
          </button>
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="inline-flex items-center gap-1.5 bg-brand text-white rounded-md
                       px-4 py-2 text-sm font-medium hover:bg-brand-dark transition-colors"
          >
            <Plus size={14} />
            New team
          </button>
        </div>
      </div>

      {initialInvitations.length > 0 && (
        <div className="bg-white border border-border rounded-lg overflow-hidden shadow-sm">
          <div className="px-4 py-2.5 border-b border-border bg-surface-2">
            <p className="text-xs font-medium text-text-muted">
              Pending invitations ({initialInvitations.length})
            </p>
          </div>
          <div className="divide-y divide-border">
            {initialInvitations.map((invitation) => (
              <div key={invitation.id} className="flex items-center justify-between px-4 py-2.5">
                <div className="flex items-center gap-2.5 min-w-0">
                  <Mail size={15} className="text-text-muted flex-none" />
                  <span className="text-sm text-text-primary truncate">{invitation.email}</span>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span
                    className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${roleBadgeStyles[invitation.role]}`}
                  >
                    {invitation.role}
                  </span>
                  <button
                    type="button"
                    onClick={() => setRevokeTarget({ id: invitation.id, email: invitation.email })}
                    className="text-text-muted hover:text-danger transition-colors"
                    title="Revoke invitation"
                  >
                    <X size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {initialTeams.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center border border-dashed border-border rounded-lg">
          <Users2 size={28} className="text-text-disabled mb-3" />
          <h3 className="text-base font-semibold text-text-primary mb-1">No teams yet</h3>
          <p className="text-sm text-text-muted mb-4">
            Create your first team to start assigning mandatory training.
          </p>
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="bg-brand text-white rounded-md px-4 py-2 text-sm font-medium"
          >
            Create your first team →
          </button>
        </div>
      ) : (
        <div className="bg-white border border-border rounded-lg overflow-hidden shadow-sm divide-y divide-border">
          {initialTeams.map((team) => (
            <button
              key={team.id}
              type="button"
              onClick={() => setDetailTeamId(team.id)}
              className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-surface-2 transition-colors"
            >
              <div className="flex items-center gap-2.5">
                <Users2 size={16} className="text-text-muted" />
                <span className="text-sm font-medium text-text-primary">{team.name}</span>
              </div>
              <span className="text-xs text-text-muted">
                {team.members.length} member{team.members.length === 1 ? "" : "s"}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Create team dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogTitle>Create a team</DialogTitle>
          <div className="space-y-4">
            <div>
              <label
                htmlFor="team-name"
                className="block text-sm font-medium text-text-primary mb-1.5"
              >
                Team name
              </label>
              <input
                id="team-name"
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
                placeholder="e.g. Engineering"
                className="w-full rounded-md border border-border bg-white px-3 py-2 text-sm
                           text-text-primary placeholder:text-text-disabled
                           focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                className="text-text-muted rounded-md px-4 py-2 text-sm font-medium hover:bg-surface-2 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleCreateTeam}
                disabled={isCreating || teamName.trim().length === 0}
                className="bg-brand text-white rounded-md px-4 py-2 text-sm font-medium
                           hover:bg-brand-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isCreating ? "Creating…" : "Create team"}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Team detail dialog */}
      <Dialog open={detailTeamId !== null} onOpenChange={(open) => !open && setDetailTeamId(null)}>
        <DialogContent className="max-w-lg">
          {detailTeam && (
            <>
              <DialogTitle>{detailTeam.name}</DialogTitle>

              <div className="mb-4">
                <label
                  htmlFor="add-member-email"
                  className="block text-sm font-medium text-text-primary mb-1.5"
                >
                  Add member by email
                </label>
                <div className="flex gap-2">
                  <input
                    id="add-member-email"
                    value={addEmail}
                    onChange={(e) => setAddEmail(e.target.value)}
                    placeholder="name@company.com"
                    disabled={isSeatLimitReached}
                    className="flex-1 rounded-md border border-border bg-white px-3 py-2 text-sm
                               text-text-primary placeholder:text-text-disabled
                               focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent
                               disabled:opacity-50 disabled:cursor-not-allowed"
                  />
                  <button
                    type="button"
                    onClick={() => handleAddMember(detailTeam.id)}
                    disabled={isAdding || isSeatLimitReached || addEmail.trim().length === 0}
                    className="bg-brand text-white rounded-md px-4 py-2 text-sm font-medium
                               hover:bg-brand-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isAdding ? "Adding…" : "Add"}
                  </button>
                </div>
                {isSeatLimitReached && (
                  <p className="text-xs text-warning mt-1.5">
                    Seat limit reached ({seatCount}/{seatLimit}). Add seats to invite more members.
                  </p>
                )}
              </div>

              <div className="border border-border rounded-lg overflow-hidden divide-y divide-border">
                {detailTeam.members.length === 0 ? (
                  <p className="px-4 py-6 text-sm text-text-muted text-center">No members yet.</p>
                ) : (
                  detailTeam.members.map(({ user }) => (
                    <div key={user.id} className="flex items-center justify-between px-4 py-2.5">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-text-primary truncate">
                          {user.name ?? user.email}
                        </p>
                        <p className="text-xs text-text-muted truncate">{user.email}</p>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <span
                          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${roleBadgeStyles[user.role]}`}
                        >
                          {user.role}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            setRemoveTarget({ userId: user.id, name: user.name ?? user.email })
                          }
                          className="text-text-muted hover:text-danger transition-colors"
                          title="Remove from team"
                        >
                          <UserMinus size={15} />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Remove member confirm */}
      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogTitle>Remove member?</AlertDialogTitle>
          <AlertDialogDescription>
            {removeTarget?.name} will be removed from {detailTeam?.name}. This does not affect their
            account or other team memberships.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                detailTeam && removeTarget && handleRemoveMember(detailTeam.id, removeTarget.userId)
              }
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Invite member dialog */}
      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent>
          <DialogTitle>Invite a member</DialogTitle>
          <div className="space-y-4">
            <div>
              <label
                htmlFor="invite-email"
                className="block text-sm font-medium text-text-primary mb-1.5"
              >
                Email
              </label>
              <input
                id="invite-email"
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="name@company.com"
                className="w-full rounded-md border border-border bg-white px-3 py-2 text-sm
                           text-text-primary placeholder:text-text-disabled
                           focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent"
              />
            </div>
            <fieldset>
              <legend className="block text-sm font-medium text-text-primary mb-1.5">Role</legend>
              <div className="grid grid-cols-2 gap-2">
                {(["STUDENT", "INSTRUCTOR"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setInviteRole(option)}
                    aria-pressed={inviteRole === option}
                    className={`rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                      inviteRole === option
                        ? "border-brand bg-brand-light text-brand-dark"
                        : "border-border bg-white text-text-secondary hover:bg-surface-2"
                    }`}
                  >
                    {option === "STUDENT" ? "Student" : "Instructor"}
                  </button>
                ))}
              </div>
            </fieldset>
            {isSeatLimitReached && (
              <p className="text-xs text-warning">
                Seat limit reached ({seatCount}/{seatLimit}). Add seats to invite more members.
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setInviteOpen(false)}
                className="text-text-muted rounded-md px-4 py-2 text-sm font-medium hover:bg-surface-2 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleInvite}
                disabled={isInviting || isSeatLimitReached || inviteEmail.trim().length === 0}
                className="bg-brand text-white rounded-md px-4 py-2 text-sm font-medium
                           hover:bg-brand-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isInviting ? "Sending…" : "Send invite"}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Revoke invitation confirm */}
      <AlertDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogTitle>Revoke invitation?</AlertDialogTitle>
          <AlertDialogDescription>
            The invitation sent to {revokeTarget?.email} will no longer be usable to join your
            organization.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => revokeTarget && handleRevokeInvitation(revokeTarget.id)}
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
