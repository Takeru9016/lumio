"use client";

import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDown, ArrowUp, GripVertical, TriangleAlert, X } from "lucide-react";
import { useState } from "react";

import type { AdminFailure } from "@/lib/admin-path-client";
import { type AdminCourseView, moveCourse, sameOrder } from "@/lib/admin-path-view";
import { FailureNotice } from "./FailureNotice";
import { PathStatusBadge } from "./PathStatusBadge";

interface PathCourseListProps {
  /** The courses in the order the server holds them. */
  courses: AdminCourseView[];
  /** Whether the path's status allows its courses to be changed at all. */
  editable: boolean;
  /** Another change is being saved: nothing here can start a second one. */
  busy: boolean;
  onRemove: (course: AdminCourseView) => void;
  /** Sends the complete order; resolves to the refusal, or null when it was saved. */
  onSaveOrder: (courseIds: string[]) => Promise<AdminFailure | null>;
}

const ICON_BUTTON =
  "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-border bg-white text-text-secondary transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-40 md:h-9 md:w-9";

interface RowProps {
  course: AdminCourseView;
  index: number;
  total: number;
  editable: boolean;
  disabled: boolean;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}

function CourseRow({ course, index, total, editable, disabled, onMove, onRemove }: RowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: course.courseId,
    disabled: !editable || disabled,
  });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-course-id={course.courseId}
      className={`rounded-lg border border-border bg-surface-1 p-3 shadow-sm ${
        isDragging ? "relative z-10 opacity-60" : ""
      }`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          {editable && (
            <button
              type="button"
              {...attributes}
              {...listeners}
              disabled={disabled}
              aria-label={`Drag to reorder ${course.title}`}
              style={{ touchAction: "none" }}
              className="inline-flex h-11 w-9 shrink-0 cursor-grab items-center justify-center rounded-md text-text-muted hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40 md:h-9"
            >
              <GripVertical size={16} aria-hidden="true" />
            </button>
          )}
          <span
            aria-hidden="true"
            className="mt-2.5 flex h-6 w-7 shrink-0 items-center justify-center rounded-md bg-surface-3 text-xs font-semibold text-text-secondary"
          >
            {String(index + 1).padStart(2, "0")}
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <p className="wrap-break-word text-sm font-semibold text-text-primary">
              <span className="sr-only">{`Position ${index + 1} of ${total}: `}</span>
              {course.title}
            </p>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <PathStatusBadge
                status={course.courseStatus}
                label={`Course ${course.statusLabel.toLowerCase()}`}
              />
              <span className="font-mono text-xs wrap-anywhere text-text-muted">{course.slug}</span>
            </div>
            {course.blockNote && (
              <p className="flex items-start gap-1.5 text-xs text-warning">
                <TriangleAlert size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                <span>{course.blockNote}</span>
              </p>
            )}
          </div>
        </div>

        {editable && (
          <div className="flex items-center gap-2 sm:justify-end">
            <button
              type="button"
              onClick={() => onMove(-1)}
              disabled={disabled || index === 0}
              aria-label={`Move ${course.title} up`}
              className={ICON_BUTTON}
            >
              <ArrowUp size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => onMove(1)}
              disabled={disabled || index === total - 1}
              aria-label={`Move ${course.title} down`}
              className={ICON_BUTTON}
            >
              <ArrowDown size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={onRemove}
              disabled={disabled}
              aria-label={`Remove ${course.title} from this path`}
              className={ICON_BUTTON}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * The path's courses in order. The order shown while it is being changed is a
 * draft held here: nothing is sent until "Save order", which sends the complete
 * list of course ids (never positions). The parent remounts this list whenever the
 * server's own order changes, so a draft never outlives the order it was made from.
 */
export function PathCourseList({
  courses,
  editable,
  busy,
  onRemove,
  onSaveOrder,
}: PathCourseListProps) {
  const serverIds = courses.map((c) => c.courseId);
  const [order, setOrder] = useState(serverIds);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<AdminFailure | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const byId = new Map(courses.map((c) => [c.courseId, c]));
  const ordered = order.flatMap((id) => byId.get(id) ?? []);
  const dirty = !sameOrder(order, serverIds);
  const disabled = busy || saving;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const titleOf = (id: string | number) => byId.get(String(id))?.title ?? "Course";
  const place = (id: string | number, ids = order) =>
    `${ids.indexOf(String(id)) + 1} of ${ids.length}`;

  function change(next: string[], said: string) {
    setOrder(next);
    setFailure(null);
    setAnnouncement(said);
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const from = order.indexOf(String(active.id));
    const to = order.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    const next = arrayMove(order, from, to);
    change(next, `${titleOf(active.id)} moved to position ${place(active.id, next)}.`);
  }

  async function save() {
    if (saving || busy) return;
    setSaving(true);
    setFailure(null);
    try {
      const refusal = await onSaveOrder(order);
      if (refusal) setFailure(refusal);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
        accessibility={{
          announcements: {
            onDragStart: ({ active }) =>
              `Picked up ${titleOf(active.id)}, position ${place(active.id)}.`,
            onDragOver: ({ active, over }) =>
              over ? `${titleOf(active.id)} is over position ${place(over.id)}.` : undefined,
            onDragEnd: ({ active }) => `Dropped ${titleOf(active.id)}.`,
            onDragCancel: ({ active }) => `Cancelled. ${titleOf(active.id)} was not moved.`,
          },
        }}
      >
        <SortableContext items={order} strategy={verticalListSortingStrategy}>
          <ol className="space-y-2" aria-label="Courses in this path, in order">
            {ordered.map((course, index) => (
              <CourseRow
                key={course.courseId}
                course={course}
                index={index}
                total={ordered.length}
                editable={editable}
                disabled={disabled}
                onMove={(delta) => {
                  const next = moveCourse(order, index, delta);
                  change(
                    next,
                    `${course.title} moved to position ${index + 1 + delta} of ${next.length}.`
                  );
                }}
                onRemove={() => onRemove(course)}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>

      <output aria-live="polite" className="sr-only">
        {announcement}
      </output>

      {failure && <FailureNotice failure={failure} />}

      {dirty && (
        <fieldset className="m-0 flex min-w-0 flex-col gap-2 rounded-lg border border-brand bg-brand-light px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
          <legend className="sr-only">Unsaved course order</legend>
          <p className="text-sm text-text-primary">The order has changed. Save it to apply it.</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setOrder(serverIds);
                setFailure(null);
                setAnnouncement("Order changes discarded.");
              }}
              disabled={disabled}
              className="min-h-11 flex-1 rounded-md border border-border bg-white px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none"
            >
              Discard
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={disabled}
              className="min-h-11 flex-1 rounded-md bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none"
            >
              {saving ? "Saving…" : "Save order"}
            </button>
          </div>
        </fieldset>
      )}
    </div>
  );
}
