"use client";

import { toast } from "gooey-toast";
import { ClipboardList, Download } from "lucide-react";
import { useState } from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { downloadCSV, generateCSV } from "@/lib/export";
import type { CompletionReportRow, CompletionStatus } from "@/lib/reports";

interface TeamOption {
  id: string;
  name: string;
}

interface CourseOption {
  id: string;
  title: string;
}

interface CompletionReportClientProps {
  initialRows: CompletionReportRow[];
  teams: TeamOption[];
  courses: CourseOption[];
}

const statusStyles: Record<CompletionStatus, string> = {
  Completed: "bg-(--color-success-bg) text-(--color-success)",
  "In Progress": "bg-(--color-info-bg) text-(--color-info)",
  "Not Started": "bg-surface-3 text-text-muted",
};

function formatDate(date: Date | null): string {
  if (!date) return "Never";
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function CompletionReportClient({
  initialRows,
  teams,
  courses,
}: CompletionReportClientProps) {
  const [rows, setRows] = useState(initialRows);
  const [teamId, setTeamId] = useState<string>("all");
  const [courseId, setCourseId] = useState<string>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  async function applyFilters(next: {
    teamId: string;
    courseId: string;
    from: string;
    to: string;
  }) {
    setIsLoading(true);
    try {
      const params = new URLSearchParams();
      if (next.teamId !== "all") params.set("teamId", next.teamId);
      if (next.courseId !== "all") params.set("courseId", next.courseId);
      if (next.from) params.set("from", next.from);
      if (next.to) params.set("to", next.to);

      const res = await fetch(`/api/org/reports/completion?${params.toString()}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setRows(data.rows);
    } catch {
      toast.error({ title: "Couldn't load report" });
    } finally {
      setIsLoading(false);
    }
  }

  function handleTeamChange(value: string) {
    setTeamId(value);
    applyFilters({ teamId: value, courseId, from, to });
  }

  function handleCourseChange(value: string) {
    setCourseId(value);
    applyFilters({ teamId, courseId: value, from, to });
  }

  function handleFromChange(value: string) {
    setFrom(value);
    applyFilters({ teamId, courseId, from: value, to });
  }

  function handleToChange(value: string) {
    setTo(value);
    applyFilters({ teamId, courseId, from, to: value });
  }

  function handleExport() {
    const csv = generateCSV(
      ["Member", "Course", "% Complete", "Last Active", "Status"],
      rows.map((r) => [
        r.memberName,
        r.courseTitle,
        `${r.percentComplete}%`,
        formatDate(r.lastActive),
        r.status,
      ])
    );
    downloadCSV(`completion-report-${new Date().toISOString().slice(0, 10)}.csv`, csv);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={teamId} onValueChange={handleTeamChange}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Team" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All teams</SelectItem>
              {teams.map((team) => (
                <SelectItem key={team.id} value={team.id}>
                  {team.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={courseId} onValueChange={handleCourseChange}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="Course" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All courses</SelectItem>
              {courses.map((course) => (
                <SelectItem key={course.id} value={course.id}>
                  {course.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <input
            type="date"
            value={from}
            onChange={(e) => handleFromChange(e.target.value)}
            className="rounded-md border border-border bg-white px-3 py-2 text-sm text-text-primary
                       focus:outline-none focus:ring-2 focus:ring-(--color-brand) focus:border-transparent"
          />
          <span className="text-sm text-text-muted">to</span>
          <input
            type="date"
            value={to}
            onChange={(e) => handleToChange(e.target.value)}
            className="rounded-md border border-border bg-white px-3 py-2 text-sm text-text-primary
                       focus:outline-none focus:ring-2 focus:ring-(--color-brand) focus:border-transparent"
          />
        </div>

        <button
          type="button"
          onClick={handleExport}
          disabled={rows.length === 0}
          className="inline-flex items-center gap-1.5 bg-(--color-brand) text-white rounded-md
                     px-4 py-2 text-sm font-medium hover:bg-(--color-brand-dark) transition-colors
                     disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Download size={14} />
          Export CSV
        </button>
      </div>

      {isLoading ? (
        <div className="bg-white border border-border rounded-lg py-16 text-center text-sm text-text-muted">
          Loading…
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-surface-2 py-12 text-center">
          <ClipboardList size={28} className="text-text-disabled mx-auto mb-2" />
          <p className="text-sm font-medium text-text-primary mb-1">No completion data</p>
          <p className="text-xs text-text-muted">Try adjusting the filters above.</p>
        </div>
      ) : (
        <div className="bg-white border border-border rounded-lg overflow-hidden shadow-sm">
          <div className="grid grid-cols-[1fr_1.5fr_110px_120px_120px] px-4 py-2.5 border-b border-border bg-surface-2">
            <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">
              Member
            </span>
            <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">
              Course
            </span>
            <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">
              % Complete
            </span>
            <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">
              Last Active
            </span>
            <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">
              Status
            </span>
          </div>

          {rows.map((row) => (
            <div
              key={`${row.userId}-${row.courseId}`}
              className="grid grid-cols-[1fr_1.5fr_110px_120px_120px] items-center px-4 py-3 border-b border-border last:border-0 hover:bg-surface-2 transition-colors"
            >
              <p className="text-sm font-medium text-text-primary truncate pr-2">
                {row.memberName}
              </p>
              <p className="text-sm text-text-secondary truncate pr-4">{row.courseTitle}</p>
              <p className="text-sm text-text-primary">{row.percentComplete}%</p>
              <p className="text-sm text-text-muted">{formatDate(row.lastActive)}</p>
              <div>
                <span
                  className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${statusStyles[row.status]}`}
                >
                  {row.status}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
