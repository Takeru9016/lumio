"use client";

import { useState, useEffect, useRef } from "react";
import { Loader2, Save, ClipboardList } from "lucide-react";
import { toast } from "gooey-toast";

import { TextEditor } from "./TextEditor";

interface AssignmentData {
  id: string;
  title: string;
  description: string;
  dueDate: string | null;
  maxScore: number;
}

interface AssignmentBuilderProps {
  courseId: string;
  lessonId: string;
}

export function AssignmentBuilder({ courseId, lessonId }: AssignmentBuilderProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [maxScore, setMaxScore] = useState(100);
  const descriptionRef = useRef("");

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(
          `/api/courses/${courseId}/lessons/${lessonId}/assignment`,
        );
        if (!res.ok) return;
        const data = (await res.json()) as { assignment: AssignmentData | null };
        if (data.assignment) {
          setTitle(data.assignment.title);
          setDescription(data.assignment.description);
          descriptionRef.current = data.assignment.description;
          setDueDate(
            data.assignment.dueDate
              ? data.assignment.dueDate.slice(0, 10)
              : "",
          );
          setMaxScore(data.assignment.maxScore);
        }
      } catch {
        // use defaults
      } finally {
        setIsLoading(false);
      }
    }
    void load();
  }, [courseId, lessonId]);

  async function handleSave() {
    if (!title.trim()) {
      toast.error({ title: "Title is required." });
      return;
    }
    const desc = descriptionRef.current;
    if (!desc || desc === "<p></p>") {
      toast.error({ title: "Instructions are required." });
      return;
    }
    setIsSaving(true);
    try {
      const res = await fetch(
        `/api/courses/${courseId}/lessons/${lessonId}/assignment`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: title.trim(),
            description: desc,
            dueDate: dueDate ? new Date(dueDate).toISOString() : null,
            maxScore,
          }),
        },
      );
      if (!res.ok) throw new Error();
      toast.success({ title: "Assignment saved" });
    } catch {
      toast.error({ title: "Failed to save assignment" });
    } finally {
      setIsSaving(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 size={20} className="animate-spin text-text-muted" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ClipboardList size={16} className="text-text-muted" />
          <p className="text-sm font-medium text-text-primary">
            Assignment Details
          </p>
        </div>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={isSaving}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-brand text-white rounded-md hover:bg-brand-dark disabled:opacity-50 transition-colors"
        >
          {isSaving ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Save size={13} />
          )}
          Save assignment
        </button>
      </div>

      {/* Title */}
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1">
          Title
        </label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Week 1 Project Submission"
          className="w-full border border-border rounded-md px-3 py-2 text-sm text-text-primary bg-surface-1 focus:outline-none focus:border-brand"
        />
      </div>

      {/* Instructions */}
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1">
          Instructions
        </label>
        <TextEditor
          content={description}
          onChange={(html) => {
            descriptionRef.current = html;
          }}
          placeholder="Describe the assignment, deliverables, and rubric…"
        />
      </div>

      {/* Due date + Max score */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">
            Due date{" "}
            <span className="text-text-disabled font-normal">(optional)</span>
          </label>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="w-full rounded-md border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-brand"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">
            Max score
          </label>
          <input
            type="number"
            value={maxScore}
            min={1}
            max={1000}
            onChange={(e) => setMaxScore(Number(e.target.value))}
            className="w-full rounded-md border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-brand"
          />
        </div>
      </div>
    </div>
  );
}
