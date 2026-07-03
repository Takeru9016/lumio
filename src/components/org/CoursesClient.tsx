"use client";

import { toast } from "gooey-toast";
import { ClipboardList } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

interface Assignment {
  id: string;
  teamName: string;
  dueDate: Date;
}

interface CourseData {
  id: string;
  title: string;
  thumbnailUrl: string | null;
  category: string | null;
  isMarketplace: boolean;
  assignments: Assignment[];
}

interface TeamOption {
  id: string;
  name: string;
}

interface CoursesClientProps {
  courses: CourseData[];
  teams: TeamOption[];
}

function formatDueDate(dueDate: Date): { label: string; isUrgent: boolean; isOverdue: boolean } {
  const now = Date.now();
  const due = new Date(dueDate).getTime();
  const msRemaining = due - now;
  const dateLabel = new Date(dueDate).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  if (msRemaining < 0) {
    return { label: `Overdue — was due ${dateLabel}`, isUrgent: false, isOverdue: true };
  }
  if (msRemaining < SEVEN_DAYS_MS) {
    const daysLeft = Math.max(Math.ceil(msRemaining / (24 * 60 * 60 * 1000)), 0);
    return {
      label: `Due in ${daysLeft} day${daysLeft === 1 ? "" : "s"} (${dateLabel})`,
      isUrgent: true,
      isOverdue: false,
    };
  }
  return { label: `Due ${dateLabel}`, isUrgent: false, isOverdue: false };
}

export function CoursesClient({ courses, teams }: CoursesClientProps) {
  const router = useRouter();
  const [assignCourseId, setAssignCourseId] = useState<string | null>(null);
  const [teamId, setTeamId] = useState<string>("");
  const [dueDate, setDueDate] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const assignCourse = courses.find((c) => c.id === assignCourseId) ?? null;

  function openAssignModal(courseId: string) {
    setAssignCourseId(courseId);
    setTeamId("");
    setDueDate("");
  }

  async function handleAssign() {
    if (!assignCourseId || !teamId || !dueDate) return;
    setIsSubmitting(true);
    try {
      const res = await fetch("/api/org/mandatory-training", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ courseId: assignCourseId, teamId, dueDate }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Couldn't assign training");
      toast.success({ title: "Assigned as mandatory training" });
      setAssignCourseId(null);
      router.refresh();
    } catch (err) {
      toast.error({ title: err instanceof Error ? err.message : "Couldn't assign training" });
    } finally {
      setIsSubmitting(false);
    }
  }

  if (courses.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center border border-dashed border-border rounded-lg">
        <ClipboardList size={28} className="text-text-disabled mb-3" />
        <h3 className="text-base font-semibold text-text-primary mb-1">No courses available</h3>
        <p className="text-sm text-text-muted">
          Courses your organization owns or published marketplace courses will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="bg-white border border-border rounded-lg overflow-hidden shadow-sm divide-y divide-border">
        {courses.map((course) => (
          <div key={course.id} className="flex items-start justify-between gap-4 px-4 py-3.5">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-medium text-text-primary truncate">{course.title}</p>
                {course.isMarketplace && (
                  <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-surface-3 text-text-muted">
                    Marketplace
                  </span>
                )}
              </div>
              {course.assignments.length > 0 && (
                <div className="mt-1.5 flex flex-col gap-1">
                  {course.assignments.map((a) => {
                    const { label, isUrgent, isOverdue } = formatDueDate(a.dueDate);
                    return (
                      <span
                        key={a.id}
                        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium w-fit ${
                          isOverdue
                            ? "bg-(--color-danger-bg) text-(--color-danger)"
                            : isUrgent
                              ? "bg-(--color-warning-bg) text-(--color-warning)"
                              : "bg-(--color-brand-light) text-(--color-brand)"
                        }`}
                      >
                        Mandatory for {a.teamName} — {label}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => openAssignModal(course.id)}
              disabled={teams.length === 0}
              className="shrink-0 bg-white text-text-primary border border-border rounded-md
                         px-3 py-1.5 text-xs font-medium hover:bg-surface-2 transition-colors
                         disabled:opacity-50 disabled:cursor-not-allowed"
              title={teams.length === 0 ? "Create a team first" : undefined}
            >
              Assign as mandatory
            </button>
          </div>
        ))}
      </div>

      <Dialog
        open={assignCourseId !== null}
        onOpenChange={(open) => !open && setAssignCourseId(null)}
      >
        <DialogContent>
          <DialogTitle>Assign as mandatory</DialogTitle>
          {assignCourse && (
            <div className="space-y-4">
              <p className="text-sm text-text-muted -mt-2">{assignCourse.title}</p>

              <div>
                <label
                  htmlFor="assign-team"
                  className="block text-sm font-medium text-text-primary mb-1.5"
                >
                  Team
                </label>
                <Select value={teamId} onValueChange={setTeamId}>
                  <SelectTrigger id="assign-team">
                    <SelectValue placeholder="Select a team" />
                  </SelectTrigger>
                  <SelectContent>
                    {teams.map((team) => (
                      <SelectItem key={team.id} value={team.id}>
                        {team.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <label
                  htmlFor="assign-due-date"
                  className="block text-sm font-medium text-text-primary mb-1.5"
                >
                  Due date
                </label>
                <input
                  id="assign-due-date"
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  className="w-full rounded-md border border-border bg-white px-3 py-2 text-sm
                             text-text-primary focus:outline-none focus:ring-2 focus:ring-(--color-brand) focus:border-transparent"
                />
              </div>

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setAssignCourseId(null)}
                  className="text-text-muted rounded-md px-4 py-2 text-sm font-medium hover:bg-surface-2 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleAssign}
                  disabled={isSubmitting || !teamId || !dueDate}
                  className="bg-(--color-brand) text-white rounded-md px-4 py-2 text-sm font-medium
                             hover:bg-(--color-brand-dark) transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isSubmitting ? "Assigning…" : "Assign"}
                </button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
