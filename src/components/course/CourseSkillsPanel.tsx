"use client";

import { toast } from "gooey-toast";
import { Tag, X } from "lucide-react";
import { useEffect, useState } from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type MappedSkill = {
  skillId: string;
  skillName: string;
  skillDescription: string | null;
};

type CatalogSkill = {
  id: string;
  name: string;
  categoryId: string | null;
  categoryName: string | null;
};

interface CourseSkillsPanelProps {
  courseId: string;
}

export function CourseSkillsPanel({ courseId }: CourseSkillsPanelProps) {
  const [mapped, setMapped] = useState<MappedSkill[]>([]);
  const [catalog, setCatalog] = useState<CatalogSkill[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedSkillId, setSelectedSkillId] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setIsLoading(true);
      try {
        const [mappedRes, catalogRes] = await Promise.all([
          fetch(`/api/courses/${courseId}/skills`),
          fetch("/api/skills"),
        ]);
        const mappedData = mappedRes.ok ? await mappedRes.json() : { skills: [] };
        const catalogData = catalogRes.ok ? await catalogRes.json() : { skills: [] };
        if (!cancelled) {
          setMapped(mappedData.skills ?? []);
          setCatalog(catalogData.skills ?? []);
        }
      } catch {
        if (!cancelled) toast.error({ title: "Failed to load skills" });
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [courseId]);

  const availableToAdd = catalog.filter((skill) => !mapped.some((m) => m.skillId === skill.id));

  async function addSkill() {
    if (!selectedSkillId) return;
    setIsSubmitting(true);
    try {
      const res = await fetch(`/api/courses/${courseId}/skills`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillId: selectedSkillId }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error({ title: data.error ?? "Failed to add skill" });
        return;
      }
      setMapped((prev) => [
        ...prev,
        {
          skillId: data.skillId,
          skillName: data.skillName,
          skillDescription: data.skillDescription,
        },
      ]);
      setSelectedSkillId("");
      toast.success({ title: `Mapped "${data.skillName}" to this course` });
    } catch {
      toast.error({ title: "Network error", description: "Failed to add skill." });
    } finally {
      setIsSubmitting(false);
    }
  }

  async function removeSkill(skillId: string, skillName: string) {
    try {
      const res = await fetch(`/api/courses/${courseId}/skills/${skillId}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 204) {
        const data = await res.json().catch(() => ({}));
        toast.error({ title: data.error ?? "Failed to remove skill" });
        return;
      }
      setMapped((prev) => prev.filter((m) => m.skillId !== skillId));
      toast.success({ title: `Removed "${skillName}" from this course` });
    } catch {
      toast.error({ title: "Network error", description: "Failed to remove skill." });
    }
  }

  if (isLoading) {
    return <div className="text-sm text-text-muted">Loading skills…</div>;
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-text-primary">Skills</h3>
        <p className="text-sm text-text-muted mt-1">
          Map this course to the capabilities it is designed to develop. Future course, quiz, and
          assignment outcomes can use these mappings to contribute capability evidence.
        </p>
      </div>

      {mapped.length > 0 ? (
        <ul className="space-y-2">
          {mapped.map((skill) => (
            <li
              key={skill.skillId}
              className="flex items-start justify-between gap-3 rounded-md border border-border bg-white px-3 py-2"
            >
              <div className="min-w-0 flex items-start gap-2">
                <Tag size={14} className="shrink-0 mt-0.5 text-text-muted" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-text-primary truncate">
                    {skill.skillName}
                  </p>
                  {skill.skillDescription && (
                    <p className="text-xs text-text-muted mt-0.5">{skill.skillDescription}</p>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void removeSkill(skill.skillId, skill.skillName)}
                className="shrink-0 text-text-muted hover:text-red-600 transition-colors"
                aria-label={`Remove ${skill.skillName}`}
              >
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-text-muted italic">No skills mapped to this course yet.</p>
      )}

      {catalog.length === 0 ? (
        <p className="text-sm text-text-muted">
          No skills exist for your organization yet. Add skills from your organization's role &
          skill settings first.
        </p>
      ) : (
        <div className="flex items-center gap-2">
          <Select value={selectedSkillId} onValueChange={setSelectedSkillId}>
            <SelectTrigger id="add-course-skill" className="flex-1">
              <SelectValue
                placeholder={
                  availableToAdd.length === 0
                    ? "All skills already mapped"
                    : "Select a skill to add"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {availableToAdd.map((skill) => (
                <SelectItem key={skill.id} value={skill.id}>
                  {skill.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <button
            type="button"
            onClick={() => void addSkill()}
            disabled={!selectedSkillId || isSubmitting || availableToAdd.length === 0}
            className="shrink-0 bg-brand text-white rounded-md px-3 py-1.5 text-sm font-medium hover:bg-brand-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? "Adding…" : "Add"}
          </button>
        </div>
      )}

      <p className="text-xs text-text-muted">
        Changes to course skill mappings do not rewrite existing learner evidence.
      </p>
    </div>
  );
}
