"use client";

import { ChevronDown, Users } from "lucide-react";
import { useState } from "react";

import { EmptyState } from "@/components";
import type { OrgCapabilityPage } from "@/lib/domain/capability/organizationReport";

interface OrgCapabilityClientProps {
  initialPage: OrgCapabilityPage;
}

function proficiencyLabel(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

export function OrgCapabilityClient({ initialPage }: OrgCapabilityClientProps) {
  const [learners, setLearners] = useState(initialPage.learners);
  const [cursor, setCursor] = useState(initialPage.nextCursor);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleExpanded(userId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  async function loadMore() {
    if (!cursor) return;
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/org/capability?cursor=${encodeURIComponent(cursor)}`);
      if (!res.ok) throw new Error();
      const data: OrgCapabilityPage = await res.json();
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
          Capability Overview
        </h1>
        <p className="text-sm text-text-muted">
          Role, required skills, and proficiency for every learner in your organization.
        </p>
      </div>

      {learners.length === 0 ? (
        <div className="bg-surface-1 border border-border rounded-lg">
          <EmptyState
            title="No learners yet"
            description="Once learners are assigned a role, their capability overview will show up here."
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
