"use client";

import { toast } from "gooey-toast";
import { Briefcase, Plus, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type SkillProficiency = "BEGINNER" | "INTERMEDIATE" | "ADVANCED" | "EXPERT";

const PROFICIENCY_OPTIONS: SkillProficiency[] = ["BEGINNER", "INTERMEDIATE", "ADVANCED", "EXPERT"];

interface RoleListItem {
  id: string;
  name: string;
  description: string | null;
  skillCount: number;
  assignedUserCount: number;
}

interface SkillOption {
  id: string;
  name: string;
}

interface RoleDetail {
  id: string;
  name: string;
  description: string | null;
  roleSkills: { skillId: string; skillName: string; requiredProficiency: SkillProficiency }[];
  assignedUsers: {
    userId: string;
    name: string | null;
    email: string;
    isPrimary: boolean;
  }[];
}

interface RolesClientProps {
  initialRoles: RoleListItem[];
  initialSkills: SkillOption[];
}

export function RolesClient({ initialRoles, initialSkills }: RolesClientProps) {
  const router = useRouter();

  const [createOpen, setCreateOpen] = useState(false);
  const [roleName, setRoleName] = useState("");
  const [roleDescription, setRoleDescription] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  const [detailRoleId, setDetailRoleId] = useState<string | null>(null);
  const [detailData, setDetailData] = useState<RoleDetail | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [isSavingDetails, setIsSavingDetails] = useState(false);

  const [selectedProficiency, setSelectedProficiency] = useState<SkillProficiency>("BEGINNER");
  const [isAddingSkill, setIsAddingSkill] = useState(false);

  const [skillCreateOpen, setSkillCreateOpen] = useState(false);
  const [skillName, setSkillName] = useState("");
  const [skillDescription, setSkillDescription] = useState("");
  const [isCreatingSkill, setIsCreatingSkill] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    name: string;
    assignedUserCount: number;
  } | null>(null);

  const detailRole = initialRoles.find((r) => r.id === detailRoleId) ?? null;

  useEffect(() => {
    if (!detailRoleId) {
      setDetailData(null);
      return;
    }
    setIsLoadingDetail(true);
    fetch(`/api/org/roles/${detailRoleId}`)
      .then((res) => res.json())
      .then((data: RoleDetail) => {
        setDetailData(data);
        setEditName(data.name);
        setEditDescription(data.description ?? "");
      })
      .catch(() => toast.error({ title: "Couldn't load role details" }))
      .finally(() => setIsLoadingDetail(false));
  }, [detailRoleId]);

  async function handleCreateRole() {
    if (roleName.trim().length === 0) return;
    setIsCreating(true);
    try {
      const res = await fetch("/api/org/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: roleName.trim(),
          description: roleDescription.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Couldn't create role");
      toast.success({ title: "Role created" });
      setRoleName("");
      setRoleDescription("");
      setCreateOpen(false);
      router.refresh();
    } catch (err) {
      toast.error({ title: err instanceof Error ? err.message : "Couldn't create role" });
    } finally {
      setIsCreating(false);
    }
  }

  async function refreshDetail(roleId: string) {
    const res = await fetch(`/api/org/roles/${roleId}`);
    if (res.ok) setDetailData(await res.json());
    router.refresh();
  }

  async function handleSaveRoleDetails() {
    if (!detailRoleId || editName.trim().length === 0) return;
    setIsSavingDetails(true);
    try {
      const res = await fetch(`/api/org/roles/${detailRoleId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editName.trim(),
          // `null` (not `undefined`) so clearing the field actually clears
          // it — updateJobRole treats an omitted `description` key as
          // "leave unchanged," only an explicit `null` clears it.
          description: editDescription.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Couldn't save changes");
      toast.success({ title: "Role updated" });
      await refreshDetail(detailRoleId);
    } catch (err) {
      toast.error({ title: err instanceof Error ? err.message : "Couldn't save changes" });
    } finally {
      setIsSavingDetails(false);
    }
  }

  async function handleAddSkill(skillId: string) {
    if (!detailRoleId || isAddingSkill) return;
    setIsAddingSkill(true);
    try {
      const res = await fetch(`/api/org/roles/${detailRoleId}/skills`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillId, requiredProficiency: selectedProficiency }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Couldn't add skill");
      toast.success({ title: "Skill requirement added" });
      await refreshDetail(detailRoleId);
    } catch (err) {
      toast.error({ title: err instanceof Error ? err.message : "Couldn't add skill" });
    } finally {
      setIsAddingSkill(false);
    }
  }

  async function handleUpdateProficiency(skillId: string, requiredProficiency: SkillProficiency) {
    if (!detailRoleId) return;
    try {
      const res = await fetch(`/api/org/roles/${detailRoleId}/skills/${skillId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requiredProficiency }),
      });
      if (!res.ok) throw new Error();
      toast.success({ title: "Requirement updated" });
      await refreshDetail(detailRoleId);
    } catch {
      toast.error({ title: "Couldn't update requirement" });
    }
  }

  async function handleRemoveSkill(skillId: string) {
    if (!detailRoleId) return;
    try {
      const res = await fetch(`/api/org/roles/${detailRoleId}/skills/${skillId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error();
      toast.success({ title: "Skill requirement removed" });
      await refreshDetail(detailRoleId);
    } catch {
      toast.error({ title: "Couldn't remove skill requirement" });
    }
  }

  async function handleCreateSkill() {
    if (skillName.trim().length === 0) return;
    setIsCreatingSkill(true);
    try {
      const res = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: skillName.trim(),
          description: skillDescription.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Couldn't create skill");
      toast.success({ title: "Skill created" });
      setSkillName("");
      setSkillDescription("");
      setSkillCreateOpen(false);
      router.refresh();
    } catch (err) {
      toast.error({ title: err instanceof Error ? err.message : "Couldn't create skill" });
    } finally {
      setIsCreatingSkill(false);
    }
  }

  async function handleDeleteRole() {
    if (!deleteTarget) return;
    try {
      const res = await fetch(`/api/org/roles/${deleteTarget.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Couldn't delete role");
      }
      toast.success({ title: "Role deleted" });
      setDetailRoleId(null);
      router.refresh();
    } catch (err) {
      toast.error({ title: err instanceof Error ? err.message : "Couldn't delete role" });
    } finally {
      setDeleteTarget(null);
    }
  }

  const availableSkills = initialSkills.filter(
    (s) => !detailData?.roleSkills.some((rs) => rs.skillId === s.id)
  );

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="inline-flex items-center gap-1.5 bg-brand text-white rounded-md
                     px-4 py-2 text-sm font-medium hover:bg-brand-dark transition-colors"
        >
          <Plus size={14} />
          Create role
        </button>
      </div>

      {initialRoles.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center border border-dashed border-border rounded-lg">
          <Briefcase size={28} className="text-text-disabled mb-3" />
          <h3 className="text-base font-semibold text-text-primary mb-1">
            No capability roles yet
          </h3>
          <p className="text-sm text-text-muted mb-4">
            Define what a role like "Frontend Engineer" needs, then assign it to your team.
          </p>
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="bg-brand text-white rounded-md px-4 py-2 text-sm font-medium"
          >
            Create role →
          </button>
        </div>
      ) : (
        <div className="bg-white border border-border rounded-lg overflow-hidden shadow-sm divide-y divide-border">
          {initialRoles.map((role) => (
            <button
              key={role.id}
              type="button"
              onClick={() => setDetailRoleId(role.id)}
              className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-surface-2 transition-colors"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <Briefcase size={16} className="text-text-muted shrink-0" />
                <div className="min-w-0">
                  <span className="text-sm font-medium text-text-primary block truncate">
                    {role.name}
                  </span>
                  {role.description && (
                    <span className="text-xs text-text-muted block truncate">
                      {role.description}
                    </span>
                  )}
                </div>
              </div>
              <span className="text-xs text-text-muted shrink-0">
                {role.skillCount} skill{role.skillCount === 1 ? "" : "s"} · {role.assignedUserCount}{" "}
                assigned
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Create role dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogTitle>Create a capability role</DialogTitle>
          <div className="space-y-4">
            <div>
              <label
                htmlFor="role-name"
                className="block text-sm font-medium text-text-primary mb-1.5"
              >
                Role name
              </label>
              <input
                id="role-name"
                value={roleName}
                onChange={(e) => setRoleName(e.target.value)}
                placeholder="e.g. Frontend Engineer"
                className="w-full rounded-md border border-border bg-white px-3 py-2 text-sm
                           text-text-primary placeholder:text-text-disabled
                           focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent"
              />
            </div>
            <div>
              <label
                htmlFor="role-description"
                className="block text-sm font-medium text-text-primary mb-1.5"
              >
                Description <span className="text-text-disabled font-normal">(optional)</span>
              </label>
              <textarea
                id="role-description"
                value={roleDescription}
                onChange={(e) => setRoleDescription(e.target.value)}
                rows={3}
                className="w-full rounded-md border border-border bg-white px-3 py-2 text-sm
                           text-text-primary placeholder:text-text-disabled
                           focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent resize-none"
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
                onClick={handleCreateRole}
                disabled={isCreating || roleName.trim().length === 0}
                className="bg-brand text-white rounded-md px-4 py-2 text-sm font-medium
                           hover:bg-brand-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isCreating ? "Creating…" : "Create role"}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Role detail dialog */}
      <Dialog open={detailRoleId !== null} onOpenChange={(open) => !open && setDetailRoleId(null)}>
        <DialogContent className="max-w-lg">
          {detailRole && (
            <>
              <DialogTitle>{detailRole.name}</DialogTitle>

              {isLoadingDetail || !detailData ? (
                <div className="py-8 text-center text-sm text-text-muted">Loading…</div>
              ) : (
                <div className="space-y-5">
                  <div className="space-y-3">
                    <div>
                      <label
                        htmlFor="edit-role-name"
                        className="block text-xs font-medium text-text-secondary mb-1"
                      >
                        Role name
                      </label>
                      <input
                        id="edit-role-name"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="w-full rounded-md border border-border bg-white px-3 py-2 text-sm
                                   text-text-primary focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="edit-role-description"
                        className="block text-xs font-medium text-text-secondary mb-1"
                      >
                        Description{" "}
                        <span className="text-text-disabled font-normal">(optional)</span>
                      </label>
                      <textarea
                        id="edit-role-description"
                        value={editDescription}
                        onChange={(e) => setEditDescription(e.target.value)}
                        rows={2}
                        className="w-full rounded-md border border-border bg-white px-3 py-2 text-sm
                                   text-text-primary focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent resize-none"
                      />
                    </div>
                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={handleSaveRoleDetails}
                        disabled={
                          isSavingDetails ||
                          editName.trim().length === 0 ||
                          (editName === detailData.name &&
                            editDescription === (detailData.description ?? ""))
                        }
                        className="bg-brand text-white rounded-md px-3 py-1.5 text-xs font-medium
                                   hover:bg-brand-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {isSavingDetails ? "Saving…" : "Save changes"}
                      </button>
                    </div>
                  </div>

                  <div>
                    <p className="text-xs font-medium text-text-secondary mb-1.5">
                      Required skills
                    </p>
                    {detailData.roleSkills.length === 0 ? (
                      <p className="text-xs text-text-muted mb-2">No skills required yet.</p>
                    ) : (
                      <div className="border border-border rounded-lg overflow-hidden divide-y divide-border mb-3">
                        {detailData.roleSkills.map((rs) => (
                          <div
                            key={rs.skillId}
                            className="flex items-center justify-between px-3 py-2"
                          >
                            <span className="text-sm text-text-primary truncate">
                              {rs.skillName}
                            </span>
                            <div className="flex items-center gap-2 shrink-0">
                              <Select
                                value={rs.requiredProficiency}
                                onValueChange={(v) =>
                                  handleUpdateProficiency(rs.skillId, v as SkillProficiency)
                                }
                              >
                                <SelectTrigger className="w-36 h-8 text-xs">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {PROFICIENCY_OPTIONS.map((p) => (
                                    <SelectItem key={p} value={p}>
                                      {p}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <button
                                type="button"
                                onClick={() => handleRemoveSkill(rs.skillId)}
                                className="text-text-muted hover:text-danger transition-colors"
                                title="Remove requirement"
                              >
                                <X size={15} />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="flex items-center gap-2 mb-2">
                      <Select
                        value={selectedProficiency}
                        onValueChange={(v) => setSelectedProficiency(v as SkillProficiency)}
                      >
                        <SelectTrigger className="w-36 h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PROFICIENCY_OPTIONS.map((p) => (
                            <SelectItem key={p} value={p}>
                              {p}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <span className="text-xs text-text-muted">required for a new skill</span>
                    </div>

                    {availableSkills.length === 0 ? (
                      <div className="rounded-md border border-dashed border-border p-3">
                        <p className="text-xs text-text-muted mb-2">
                          No more skills to add.{" "}
                          <button
                            type="button"
                            onClick={() => setSkillCreateOpen(true)}
                            className="text-brand hover:underline"
                          >
                            Create a skill
                          </button>
                        </p>
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {availableSkills.map((skill) => (
                          <button
                            key={skill.id}
                            type="button"
                            disabled={isAddingSkill}
                            onClick={() => handleAddSkill(skill.id)}
                            className="text-xs rounded-full px-2.5 py-1 border border-border bg-surface-2
                                       text-text-muted hover:border-brand hover:text-brand transition-colors disabled:opacity-50"
                          >
                            + {skill.name}
                          </button>
                        ))}
                        <button
                          type="button"
                          onClick={() => setSkillCreateOpen(true)}
                          className="text-xs rounded-full px-2.5 py-1 border border-dashed border-border text-text-muted hover:border-brand hover:text-brand transition-colors"
                        >
                          + New skill
                        </button>
                      </div>
                    )}
                  </div>

                  <div>
                    <p className="text-xs font-medium text-text-secondary mb-1.5">Assigned users</p>
                    {detailData.assignedUsers.length === 0 ? (
                      <p className="text-xs text-text-muted">
                        No one is assigned to this role yet. Assign it from a member's row on the
                        Teams page.
                      </p>
                    ) : (
                      <div className="border border-border rounded-lg overflow-hidden divide-y divide-border">
                        {detailData.assignedUsers.map((u) => (
                          <div
                            key={u.userId}
                            className="flex items-center justify-between px-3 py-2"
                          >
                            <div className="min-w-0">
                              <p className="text-sm text-text-primary truncate">
                                {u.name ?? u.email}
                              </p>
                              <p className="text-xs text-text-muted truncate">{u.email}</p>
                            </div>
                            {u.isPrimary && (
                              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-brand-light text-brand shrink-0">
                                Primary
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="border-t border-border pt-4 flex justify-end">
                    <button
                      type="button"
                      onClick={() =>
                        setDeleteTarget({
                          id: detailRole.id,
                          name: detailRole.name,
                          assignedUserCount: detailData.assignedUsers.length,
                        })
                      }
                      className="inline-flex items-center gap-1.5 text-sm text-danger hover:bg-danger-bg rounded-md px-3 py-1.5 transition-colors"
                    >
                      <Trash2 size={14} />
                      Delete role
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Create skill mini-form */}
      <Dialog open={skillCreateOpen} onOpenChange={setSkillCreateOpen}>
        <DialogContent>
          <DialogTitle>Create a skill</DialogTitle>
          <div className="space-y-4">
            <div>
              <label
                htmlFor="skill-name"
                className="block text-sm font-medium text-text-primary mb-1.5"
              >
                Skill name
              </label>
              <input
                id="skill-name"
                value={skillName}
                onChange={(e) => setSkillName(e.target.value)}
                placeholder="e.g. React"
                className="w-full rounded-md border border-border bg-white px-3 py-2 text-sm
                           text-text-primary placeholder:text-text-disabled
                           focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent"
              />
            </div>
            <div>
              <label
                htmlFor="skill-description"
                className="block text-sm font-medium text-text-primary mb-1.5"
              >
                Description <span className="text-text-disabled font-normal">(optional)</span>
              </label>
              <textarea
                id="skill-description"
                value={skillDescription}
                onChange={(e) => setSkillDescription(e.target.value)}
                rows={2}
                className="w-full rounded-md border border-border bg-white px-3 py-2 text-sm
                           text-text-primary placeholder:text-text-disabled
                           focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent resize-none"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setSkillCreateOpen(false)}
                className="text-text-muted rounded-md px-4 py-2 text-sm font-medium hover:bg-surface-2 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleCreateSkill}
                disabled={isCreatingSkill || skillName.trim().length === 0}
                className="bg-brand text-white rounded-md px-4 py-2 text-sm font-medium
                           hover:bg-brand-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isCreatingSkill ? "Creating…" : "Create skill"}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete role confirm */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogTitle>Delete role?</AlertDialogTitle>
          <AlertDialogDescription>
            {deleteTarget && deleteTarget.assignedUserCount > 0
              ? `Remove all ${deleteTarget.assignedUserCount} assigned user(s) before deleting this role.`
              : `"${deleteTarget?.name}" and its skill requirements will be permanently deleted.`}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteRole}
              disabled={!!deleteTarget && deleteTarget.assignedUserCount > 0}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
