"use client";

import { ChevronDown, Users } from "lucide-react";
import { useState } from "react";

import { EmptyState } from "@/components";
import type {
  InstructorCapabilityLearnerRow,
  InstructorCapabilityPage,
  InstructorLearnerRoleOption,
} from "@/lib/domain/capability/instructorReport";
import { InstructorCopilotPanel } from "./InstructorCopilotPanel";

interface InstructorCapabilityClientProps {
  initialPage: InstructorCapabilityPage;
}

function proficiencyLabel(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

type RoleSwitchState = {
  roles: InstructorLearnerRoleOption[];
  selectedRoleId: string;
  loading: boolean;
};

export function InstructorCapabilityClient({ initialPage }: InstructorCapabilityClientProps) {
  const [learners, setLearners] = useState(initialPage.learners);
  const [cursor, setCursor] = useState(initialPage.nextCursor);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedLearner, setSelectedLearner] = useState<{
    id: string;
    name: string;
    roleId: string;
  } | null>(null);
  // Phase 21 — per-learner role-switcher state, keyed by userId. Populated
  // lazily on first expand of a multi-role learner's row; switching roles
  // only replaces that one learner's row (via displayedRow below), never
  // touches the batch-fetched `learners` list or any other row.
  const [roleSwitch, setRoleSwitch] = useState<Map<string, RoleSwitchState>>(new Map());

  async function openRoleSwitcher(learnerId: string) {
    if (roleSwitch.has(learnerId)) return;
    setRoleSwitch((prev) => {
      const next = new Map(prev);
      next.set(learnerId, { roles: [], selectedRoleId: "", loading: true });
      return next;
    });
    try {
      const res = await fetch(`/api/instructor/capability/${learnerId}`);
      if (!res.ok) throw new Error();
      const data: {
        roles: InstructorLearnerRoleOption[];
        learner: InstructorCapabilityLearnerRow | null;
      } = await res.json();
      setRoleSwitch((prev) => {
        const next = new Map(prev);
        next.set(learnerId, {
          roles: data.roles,
          selectedRoleId: data.learner?.roleId ?? "",
          loading: false,
        });
        return next;
      });
      if (data.learner) {
        setLearners((prev) =>
          prev.map((l) =>
            l.userId === learnerId ? (data.learner as InstructorCapabilityLearnerRow) : l
          )
        );
      }
    } catch {
      setRoleSwitch((prev) => {
        const next = new Map(prev);
        next.delete(learnerId);
        return next;
      });
      setError("Couldn't load this learner's roles");
    }
  }

  async function switchLearnerRole(learnerId: string, roleId: string) {
    const current = roleSwitch.get(learnerId);
    if (!current || current.selectedRoleId === roleId) return;
    setRoleSwitch((prev) => {
      const next = new Map(prev);
      next.set(learnerId, { ...current, loading: true });
      return next;
    });
    try {
      const res = await fetch(
        `/api/instructor/capability/${learnerId}?roleId=${encodeURIComponent(roleId)}`
      );
      if (!res.ok) throw new Error();
      const data: {
        roles: InstructorLearnerRoleOption[];
        learner: InstructorCapabilityLearnerRow | null;
      } = await res.json();
      setRoleSwitch((prev) => {
        const next = new Map(prev);
        next.set(learnerId, {
          roles: data.roles,
          selectedRoleId: data.learner?.roleId ?? roleId,
          loading: false,
        });
        return next;
      });
      if (data.learner) {
        setLearners((prev) =>
          prev.map((l) =>
            l.userId === learnerId ? (data.learner as InstructorCapabilityLearnerRow) : l
          )
        );
      }
    } catch {
      setRoleSwitch((prev) => {
        const next = new Map(prev);
        next.set(learnerId, { ...current, loading: false });
        return next;
      });
      setError("Couldn't switch role for this learner");
    }
  }

  function toggleExpanded(userId: string) {
    const willExpand = !expanded.has(userId);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
    const learner = learners.find((l) => l.userId === userId);
    if (willExpand && learner?.hasMultipleRoles) {
      void openRoleSwitcher(userId);
    }
  }

  async function loadMore() {
    if (!cursor) return;
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/instructor/capability?cursor=${encodeURIComponent(cursor)}`);
      if (!res.ok) throw new Error();
      const data: InstructorCapabilityPage = await res.json();
      setLearners((prev) => [...prev, ...data.learners]);
      setCursor(data.nextCursor);
    } catch {
      setError("Couldn't load more learners");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="space-y-1">
        <h1
          className="text-xl font-bold text-text-primary"
          style={{ fontFamily: "var(--font-heading)" }}
        >
          Student Capability
        </h1>
        <p className="text-sm text-text-muted">
          Role, required skills, and proficiency for students enrolled in your courses.
        </p>
      </div>

      <InstructorCopilotPanel
        selectedLearner={selectedLearner}
        onClearLearner={() => setSelectedLearner(null)}
      />

      {learners.length === 0 ? (
        <div className="bg-surface-1 border border-border rounded-lg">
          <EmptyState
            title="No students yet"
            description="Once your enrolled students are assigned a role, their capability overview will show up here."
          />
        </div>
      ) : (
        <div className="bg-white border border-border rounded-lg overflow-hidden shadow-sm">
          <div className="grid grid-cols-[1.5fr_1.5fr_110px_110px] px-4 py-2.5 border-b border-border bg-surface-2">
            <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">
              Learner
            </span>
            <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">
              Role
            </span>
            <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">
              Skills Met
            </span>
            <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">
              Skills Gap
            </span>
          </div>

          {learners.map((learner) => {
            const metCount = learner.skills.filter((s) => s.met).length;
            const gapCount = learner.skills.filter((s) => !s.met).length;
            const isExpanded = expanded.has(learner.userId);

            return (
              <div key={learner.userId} className="border-b border-border last:border-0">
                <button
                  type="button"
                  onClick={() => toggleExpanded(learner.userId)}
                  className="w-full grid grid-cols-[1.5fr_1.5fr_110px_110px] items-center px-4 py-3 hover:bg-surface-2 transition-colors text-left"
                >
                  <span className="text-sm font-medium text-text-primary truncate pr-2">
                    {learner.name}
                  </span>
                  <span className="text-sm text-text-secondary truncate pr-2">
                    {learner.roleName}
                  </span>
                  <span className="text-sm text-text-primary">{metCount}</span>
                  <span className="flex items-center gap-1.5 text-sm text-text-primary">
                    {gapCount}
                    <ChevronDown
                      size={14}
                      className={`text-text-muted transition-transform ${isExpanded ? "rotate-180" : ""}`}
                    />
                  </span>
                </button>

                {isExpanded && (
                  <div className="px-4 pb-3">
                    {learner.hasMultipleRoles && (
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-xs text-text-muted">Role:</span>
                        {roleSwitch.get(learner.userId)?.roles.length ? (
                          <select
                            value={roleSwitch.get(learner.userId)?.selectedRoleId ?? learner.roleId}
                            disabled={roleSwitch.get(learner.userId)?.loading}
                            onChange={(e) => switchLearnerRole(learner.userId, e.target.value)}
                            className="text-xs font-medium text-text-primary bg-white border border-border rounded-md px-2 py-1 focus:outline-none focus:ring-2 focus:ring-brand disabled:opacity-60"
                          >
                            {roleSwitch.get(learner.userId)?.roles.map((r) => (
                              <option key={r.roleId} value={r.roleId}>
                                {r.roleName}
                                {r.isPrimary ? " (primary)" : ""}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="text-xs text-text-muted">Loading roles…</span>
                        )}
                      </div>
                    )}
                    {learner.skills.length === 0 ? (
                      <p className="text-xs text-text-muted py-2">
                        No skills configured for this role.
                      </p>
                    ) : (
                      <div className="bg-surface-2 rounded-md overflow-hidden">
                        <div className="grid grid-cols-[1.5fr_100px_100px_80px] px-3 py-1.5 border-b border-border">
                          <span className="text-xs font-semibold text-text-muted uppercase">
                            Skill
                          </span>
                          <span className="text-xs font-semibold text-text-muted uppercase">
                            Required
                          </span>
                          <span className="text-xs font-semibold text-text-muted uppercase">
                            Current
                          </span>
                          <span className="text-xs font-semibold text-text-muted uppercase">
                            Met
                          </span>
                        </div>
                        {learner.skills.map((skill) => (
                          <div
                            key={skill.skillId}
                            className="grid grid-cols-[1.5fr_100px_100px_80px] items-center px-3 py-1.5 border-b border-border last:border-0"
                          >
                            <span className="text-xs text-text-primary truncate pr-2">
                              {skill.skillName}
                            </span>
                            <span className="text-xs text-text-muted">
                              {proficiencyLabel(skill.required)}
                            </span>
                            <span className="text-xs text-text-muted">
                              {proficiencyLabel(skill.current)}
                            </span>
                            <span
                              className={`text-xs font-medium ${skill.met ? "text-text-muted" : "text-ai"}`}
                            >
                              {skill.met ? "Met" : "Gap"}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        setSelectedLearner({
                          id: learner.userId,
                          name: learner.name,
                          roleId: learner.roleId,
                        })
                      }
                      className="mt-2 text-xs text-ai hover:underline"
                    >
                      Ask Copilot about {learner.name}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {error && <p className="text-sm text-danger">{error}</p>}

      {cursor && (
        <div className="flex justify-center">
          <button
            type="button"
            disabled={isLoading}
            onClick={loadMore}
            className="flex items-center gap-2 bg-surface-2 border border-border rounded-md px-4 py-2 text-sm font-medium text-text-primary hover:bg-surface-3 transition-colors disabled:opacity-60"
          >
            <Users size={14} />
            {isLoading ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}
